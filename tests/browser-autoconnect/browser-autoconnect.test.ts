import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  browserProfileDirs,
  browserSessionMarkerPath,
  checkRemoteDebugging,
  isHarnessEnabled,
  parseDevToolsActivePort,
  registerBrowserAutoconnect,
  type RemoteDebuggingDeps,
} from "../../extensions/browser-autoconnect/index.js";

interface Command {
  name: string;
  sourceInfo?: { path?: string };
}

interface TestContext {
  hasUI: boolean;
  ui: { notify: ReturnType<typeof vi.fn> };
}

type SessionStartHandler = (event: { reason: string }, ctx: TestContext) => Promise<void>;

const HARNESS_COMMANDS: Command[] = [
  { name: "browser-status", sourceInfo: { path: "/packages/pi-browser-harness/src/index.ts" } },
];

const EDGE = { browser: "Edge", dir: "/edge" };
const CHROME = { browser: "Chrome", dir: "/chrome" };

function fakeFs(files: Record<string, string>): RemoteDebuggingDeps["readFile"] {
  return async (path) => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return content;
  };
}

const noWrite: NonNullable<RemoteDebuggingDeps["writeFile"]> = async () => undefined;

function createHarness(deps: RemoteDebuggingDeps, commands: Command[] = HARNESS_COMMANDS) {
  let sessionStart: SessionStartHandler | undefined;
  const sendUserMessage = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: SessionStartHandler) => {
      if (event === "session_start") sessionStart = handler;
    }),
    getCommands: vi.fn(() => commands),
    sendUserMessage,
  } as unknown as ExtensionAPI;

  registerBrowserAutoconnect(pi, deps);

  return {
    pi,
    sendUserMessage,
    start: async (reason = "startup", hasUI = true) => {
      if (!sessionStart) throw new Error("session_start handler was not registered");
      const ctx: TestContext = { hasUI, ui: { notify: vi.fn() } };
      await sessionStart({ reason }, ctx);
      return ctx;
    },
  };
}

describe("checkRemoteDebugging", () => {
  it("reports enabled when DevToolsActivePort exists and its WebSocket probe succeeds", async () => {
    const probePort = vi.fn(async (port: number) => port === 9333);
    const status = await checkRemoteDebugging({
      dirs: [EDGE, CHROME],
      markerPath: "/marker",
      readFile: fakeFs({ "/edge/DevToolsActivePort": "9333\n/devtools/browser/abc\n" }),
      writeFile: noWrite,
      probePort,
    });
    expect(status).toEqual({ enabled: true, browser: "Edge", port: 9333 });
  });

  it("ignores stale port files whose port is not listening", async () => {
    const status = await checkRemoteDebugging({
      dirs: [EDGE, CHROME],
      markerPath: "/marker",
      readFile: fakeFs({
        "/edge/DevToolsActivePort": "9333\n/devtools/browser/old\n",
        "/chrome/DevToolsActivePort": "9444\n/devtools/browser/new\n",
      }),
      writeFile: noWrite,
      probePort: async (port) => port === 9444,
    });
    expect(status).toEqual({ enabled: true, browser: "Chrome", port: 9444 });
  });

  it("does not treat a listening port as enabled while the WebSocket is awaiting Allow", async () => {
    const probePort = vi.fn(async () => false);
    const status = await checkRemoteDebugging({
      dirs: [EDGE],
      markerPath: "/marker",
      readFile: fakeFs({ "/edge/DevToolsActivePort": "9222\n/devtools/browser/pending\n" }),
      writeFile: noWrite,
      probePort,
    });
    expect(status).toEqual({ enabled: false });
    expect(probePort).toHaveBeenCalledWith(9222, "/devtools/browser/pending");
  });

  it("reuses the approval marker without opening another DevTools connection", async () => {
    const probePort = vi.fn(async () => false);
    const status = await checkRemoteDebugging({
      dirs: [EDGE],
      markerPath: "/marker",
      readFile: fakeFs({
        "/edge/DevToolsActivePort": "9222\n/devtools/browser/session-a\n",
        "/marker": JSON.stringify({ browser: "Edge", dir: "/edge", port: 9222, browserPath: "/devtools/browser/session-a" }),
      }),
      probePort,
    });
    expect(status).toEqual({ enabled: true, browser: "Edge", port: 9222 });
    expect(probePort).not.toHaveBeenCalled();
  });

  it("persists a successful probe and reuses it on the next pi process", async () => {
    let marker: string | undefined;
    const readFile = async (path: string): Promise<string> => {
      if (path === "/edge/DevToolsActivePort") return "9222\n/devtools/browser/session-b\n";
      if (path === "/marker" && marker !== undefined) return marker;
      throw new Error("ENOENT");
    };
    const writeFile = vi.fn(async (_path: string, data: string): Promise<void> => {
      marker = data;
    });
    const probePort = vi.fn(async () => true);
    const deps: RemoteDebuggingDeps = {
      dirs: [EDGE],
      markerPath: "/marker",
      readFile,
      writeFile,
      probePort,
    };

    await checkRemoteDebugging(deps);
    const second = await checkRemoteDebugging(deps);

    expect(second).toEqual({ enabled: true, browser: "Edge", port: 9222 });
    expect(probePort).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("reports disabled when no port file exists", async () => {
    const probePort = vi.fn(async () => true);
    const status = await checkRemoteDebugging({ dirs: [EDGE, CHROME], readFile: fakeFs({}), writeFile: noWrite, probePort });
    expect(status).toEqual({ enabled: false });
    expect(probePort).not.toHaveBeenCalled();
  });

  it("parses only valid port numbers and requires the browser WebSocket path", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/x")).toBe(9222);
    expect(parseDevToolsActivePort("9222")).toBeUndefined();
    expect(parseDevToolsActivePort("")).toBeUndefined();
    expect(parseDevToolsActivePort("70000\n/x")).toBeUndefined();
  });

  it("checks Edge before Chrome on macOS", () => {
    const dirs = browserProfileDirs("darwin", {}, "/Users/me");
    expect(dirs[0]).toEqual({ browser: "Edge", dir: "/Users/me/Library/Application Support/Microsoft Edge" });
    expect(dirs.findIndex((d) => d.browser === "Edge")).toBeLessThan(dirs.findIndex((d) => d.browser === "Chrome"));
  });

  it("stores the marker under pi's agent directory", () => {
    expect(browserSessionMarkerPath({}, "/Users/me")).toBe("/Users/me/.pi/agent/browser-autoconnect.json");
    expect(browserSessionMarkerPath({ PI_CODING_AGENT_DIR: "~/custom-agent" }, "/Users/me"))
      .toBe("/Users/me/custom-agent/browser-autoconnect.json");
  });
});

describe("browser auto-connect", () => {
  const enabledDeps: RemoteDebuggingDeps = {
    dirs: [EDGE],
    markerPath: "/marker",
    readFile: fakeFs({ "/edge/DevToolsActivePort": "9222\n/devtools/browser/abc\n" }),
    writeFile: noWrite,
    probePort: async () => true,
  };
  const disabledDeps: RemoteDebuggingDeps = { dirs: [EDGE], readFile: fakeFs({}), probePort: async () => false };

  it("logs an info notification when remote debugging is enabled, without running setup", async () => {
    const harness = createHarness(enabledDeps);
    const ctx = await harness.start();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Browser remote debugging enabled (Edge, port 9222)", "info");
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("warns when remote debugging is not enabled", async () => {
    const harness = createHarness(disabledDeps);
    const ctx = await harness.start();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("edge://inspect/#remote-debugging"), "warning");
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("checks only once per process", async () => {
    const harness = createHarness(enabledDeps);
    await harness.start();
    const second = await harness.start();
    expect(second.ui.notify).not.toHaveBeenCalled();
  });

  it.each(["new", "resume", "fork", "reload"])("does not run for %s sessions", async (reason) => {
    const harness = createHarness(enabledDeps);
    const ctx = await harness.start(reason);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not run for sessions without a UI", async () => {
    const harness = createHarness(enabledDeps);
    const ctx = await harness.start("startup", false);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not run when pi-browser-harness is not loaded", async () => {
    const harness = createHarness(enabledDeps, [
      { name: "browser-status", sourceInfo: { path: "/extensions/other/src/index.ts" } },
    ]);
    expect(isHarnessEnabled(harness.pi)).toBe(false);
    const ctx = await harness.start();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
