import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBrowserConnected, isHarnessEnabled, registerBrowserAutoconnect } from "../../extensions/browser-autoconnect/index.js";

interface Command {
  name: string;
  sourceInfo?: { path?: string };
}

interface TestContext {
  hasUI: boolean;
  ui: { notify: ReturnType<typeof vi.fn> };
}

function createHarness(commands: Command[] = [
  { name: "browser-status", sourceInfo: { path: "/packages/pi-browser-harness/src/index.ts" } },
  { name: "browser-setup", sourceInfo: { path: "/packages/pi-browser-harness/src/setup.ts" } },
]) {
  let sessionStart: ((event: { reason: string }, ctx: TestContext) => void) | undefined;
  const sendUserMessage = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: { reason: string }, ctx: TestContext) => void) => {
      if (event === "session_start") sessionStart = handler;
    }),
    getCommands: vi.fn(() => commands),
    sendUserMessage,
  } as unknown as ExtensionAPI;

  registerBrowserAutoconnect(pi);

  return {
    pi,
    sendUserMessage,
    start: (reason = "startup", hasUI = true) => {
      if (!sessionStart) throw new Error("session_start handler was not registered");
      const ctx: TestContext = { hasUI, ui: { notify: vi.fn() } };
      sessionStart({ reason }, ctx);
      return ctx;
    },
  };
}

describe("browser auto-connect", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches browser setup once on interactive startup when harness is enabled", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.start();
    await vi.runAllTimersAsync();

    expect(harness.sendUserMessage).toHaveBeenCalledOnce();
    expect(harness.sendUserMessage).toHaveBeenCalledWith("/browser-setup", {
      expandPromptTemplates: true,
    });

    harness.start();
    await vi.runAllTimersAsync();
    expect(harness.sendUserMessage).toHaveBeenCalledOnce();
  });

  it.each(["new", "resume", "fork", "reload"])("does not run for %s sessions", async (reason) => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.start(reason);
    await vi.runAllTimersAsync();

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not run for sessions without a UI", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.start("startup", false);
    await vi.runAllTimersAsync();

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not run when the browser harness status command is absent or from another extension", async () => {
    vi.useFakeTimers();
    const absent = createHarness([{ name: "browser-setup" }]);
    absent.start();
    await vi.runAllTimersAsync();
    expect(absent.sendUserMessage).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const otherExtension = createHarness([
      { name: "browser-status", sourceInfo: { path: "/extensions/other/src/index.ts" } },
      { name: "browser-setup" },
    ]);
    otherExtension.start();
    await vi.runAllTimersAsync();
    expect(otherExtension.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not run when browser setup is not available after the deferred check", async () => {
    vi.useFakeTimers();
    const harness = createHarness([
      { name: "browser-status", sourceInfo: { path: "/packages/pi-browser-harness/src/index.ts" } },
    ]);

    harness.start();
    await vi.runAllTimersAsync();

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("notifies a warning when setup dispatch throws", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.sendUserMessage.mockImplementation(() => {
      throw new Error("dispatch failed");
    });

    const ctx = harness.start();
    await vi.runAllTimersAsync();

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Browser auto-connect failed: Error: dispatch failed",
      "warning",
    );
  });

  it("exposes deterministic startup status helpers", () => {
    const harness = createHarness();
    expect(isHarnessEnabled(harness.pi)).toBe(true);
    expect(isBrowserConnected()).toBe(false);
  });
});
