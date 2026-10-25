import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SessionStartContext {
  readonly hasUI: boolean;
  readonly ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}

interface SessionStartEvent {
  readonly reason: string;
}

export interface BrowserProfileDir {
  readonly browser: string;
  readonly dir: string;
}

export type RemoteDebuggingStatus =
  | { readonly enabled: true; readonly browser: string; readonly port: number }
  | { readonly enabled: false };

export interface RemoteDebuggingDeps {
  readonly dirs?: ReadonlyArray<BrowserProfileDir>;
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeFile?: (path: string, data: string) => Promise<void>;
  readonly markerPath?: string;
  /** A successful probe must complete a DevTools WebSocket handshake, not only open TCP. */
  readonly probePort?: (port: number, browserPath?: string) => Promise<boolean>;
}

export function isHarnessEnabled(pi: ExtensionAPI): boolean {
  return pi.getCommands().some(
    (command) => command.name === "browser-status" && command.sourceInfo?.path?.includes("pi-browser-harness"),
  );
}

/** Same user-data dirs pi-browser-harness scans, Edge first since it is the primary browser here. */
export function browserProfileDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): BrowserProfileDir[] {
  const dirs: BrowserProfileDir[] = [];
  const override = env["CHROME_USER_DATA_DIR"];
  if (override) dirs.push({ browser: "Custom", dir: override.replace(/^~(?=$|[/\\])/, home) });

  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    for (const [browser, sub] of [
      ["Edge", "Microsoft Edge"],
      ["Edge Beta", "Microsoft Edge Beta"],
      ["Edge Dev", "Microsoft Edge Dev"],
      ["Edge Canary", "Microsoft Edge Canary"],
      ["Chrome", "Google/Chrome"],
      ["Chrome Beta", "Google/Chrome Beta"],
      ["Chrome Dev", "Google/Chrome Dev"],
      ["Chrome Canary", "Google/Chrome Canary"],
      ["Chromium", "Chromium"],
      ["Brave", "BraveSoftware/Brave-Browser"],
    ] as const) dirs.push({ browser, dir: join(base, sub) });
  } else if (platform === "win32") {
    const base = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    for (const [browser, sub] of [
      ["Edge", "Microsoft/Edge/User Data"],
      ["Edge Beta", "Microsoft/Edge Beta/User Data"],
      ["Edge Dev", "Microsoft/Edge Dev/User Data"],
      ["Edge Canary", "Microsoft/Edge SxS/User Data"],
      ["Chrome", "Google/Chrome/User Data"],
      ["Chrome Canary", "Google/Chrome SxS/User Data"],
      ["Chromium", "Chromium/User Data"],
      ["Brave", "BraveSoftware/Brave-Browser/User Data"],
    ] as const) dirs.push({ browser, dir: join(base, sub) });
  } else {
    for (const [browser, sub] of [
      ["Edge", ".config/microsoft-edge"],
      ["Edge Beta", ".config/microsoft-edge-beta"],
      ["Edge Dev", ".config/microsoft-edge-dev"],
      ["Chrome", ".config/google-chrome"],
      ["Chrome Beta", ".config/google-chrome-beta"],
      ["Chromium", ".config/chromium"],
      ["Brave", ".config/BraveSoftware/Brave-Browser"],
    ] as const) dirs.push({ browser, dir: join(home, sub) });
  }
  return dirs;
}

const DEVTOOLS_PROBE_TIMEOUT_MS = 5_000;

interface BrowserSessionMarker {
  readonly browser: string;
  readonly dir: string;
  readonly port: number;
  readonly browserPath: string;
}

const expandMarkerDir = (value: string, home: string): string =>
  value.replace(/^~(?=$|[/\\])/, home);

/** Approval is remembered only for the current browser process, identified by its DevTools UUID. */
export function browserSessionMarkerPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env["PI_CODING_AGENT_DIR"];
  const agentDir = configured ? expandMarkerDir(configured, home) : join(home, ".pi", "agent");
  return join(agentDir, "browser-autoconnect.json");
}

function isMatchingMarker(value: string, candidate: BrowserSessionMarker): boolean {
  try {
    const parsed = JSON.parse(value) as Partial<BrowserSessionMarker>;
    return parsed.browser === candidate.browser
      && parsed.dir === candidate.dir
      && parsed.port === candidate.port
      && parsed.browserPath === candidate.browserPath;
  } catch {
    return false;
  }
}

/**
 * Complete the browser's DevTools WebSocket upgrade. A bare TCP connect is not enough: Edge/Chrome
 * opens the port before the user approves the "Allow remote debugging?" dialog, so TCP alone reports
 * a false positive. In approval mode the HTTP upgrade remains pending until Allow is clicked.
 */
export function probePort(port: number, browserPath?: string, timeoutMs = DEVTOOLS_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!browserPath || !browserPath.startsWith("/")) return Promise.resolve(false);

  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    let response = "";
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET ${browserPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      finish(/^HTTP\/1\.[01] 101(?: |\r|\n)/.test(response));
    });
  });
}

interface DevToolsActivePort {
  readonly port: number;
  readonly browserPath: string;
}

export function parseDevToolsActivePortInfo(raw: string): DevToolsActivePort | undefined {
  const [portLine, browserPathLine] = raw.split(/\r?\n/).map((line) => line.trim());
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return undefined;
  if (!browserPathLine?.startsWith("/")) return undefined;
  return { port, browserPath: browserPathLine };
}

export function parseDevToolsActivePort(raw: string): number | undefined {
  return parseDevToolsActivePortInfo(raw)?.port;
}

/**
 * Remote debugging is enabled only after a real DevTools WebSocket connection is accepted. The
 * browser creates DevToolsActivePort and starts listening before the per-connection Allow dialog is
 * approved, so checking the file or TCP port alone is not authoritative.
 */
export async function checkRemoteDebugging(deps: RemoteDebuggingDeps = {}): Promise<RemoteDebuggingStatus> {
  const dirs = deps.dirs ?? browserProfileDirs();
  const read = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  const save = deps.writeFile ?? (async (path: string, data: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, "utf8");
  });
  const markerPath = deps.markerPath ?? browserSessionMarkerPath();
  const probe = deps.probePort ?? probePort;

  for (const { browser, dir } of dirs) {
    let raw: string;
    try {
      raw = await read(join(dir, "DevToolsActivePort"));
    } catch {
      continue;
    }
    const endpoint = parseDevToolsActivePortInfo(raw);
    if (endpoint === undefined) continue;

    const candidate: BrowserSessionMarker = { browser, dir, ...endpoint };
    try {
      // Never open a second DevTools connection for a browser session we already approved. That
      // connection itself causes Edge/Chrome to show "Allow remote debugging?" again on every pi.
      if (isMatchingMarker(await read(markerPath), candidate)) {
        return { enabled: true, browser, port: endpoint.port };
      }
    } catch {
      // No marker yet, so perform the one probe that can establish approval for this browser process.
    }

    if (await probe(endpoint.port, endpoint.browserPath)) {
      try {
        await save(markerPath, `${JSON.stringify(candidate)}\n`);
      } catch {
        // A failed marker write does not change the successful probe result; the next pi may probe once more.
      }
      return { enabled: true, browser, port: endpoint.port };
    }
  }
  return { enabled: false };
}

export function registerBrowserAutoconnect(pi: ExtensionAPI, deps: RemoteDebuggingDeps = {}): void {
  let done = false;

  pi.on("session_start", async (event, ctx) => {
    const sessionEvent = event as SessionStartEvent;
    const sessionContext = ctx as unknown as SessionStartContext;
    if (done || sessionEvent.reason !== "startup" || !sessionContext.hasUI) return;
    done = true;
    if (!isHarnessEnabled(pi)) return;

    try {
      const status = await checkRemoteDebugging(deps);
      if (status.enabled) {
        sessionContext.ui.notify(`Browser remote debugging enabled (${status.browser}, port ${status.port})`, "info");
      } else {
        sessionContext.ui.notify(
          "Browser remote debugging is not enabled. Open edge://inspect/#remote-debugging " +
            "(or chrome://inspect/#remote-debugging), enable it, then run /browser-setup.",
          "warning",
        );
      }
    } catch (error) {
      sessionContext.ui.notify(`Browser remote debugging check failed: ${String(error)}`, "warning");
    }
  });
}

export default registerBrowserAutoconnect;
