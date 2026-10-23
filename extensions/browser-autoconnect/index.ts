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

export function hasCommand(pi: ExtensionAPI, name: string): boolean {
  return pi.getCommands().some((command) => command.name === name);
}

export function isHarnessEnabled(pi: ExtensionAPI): boolean {
  return pi.getCommands().some(
    (command) => command.name === "browser-status" && command.sourceInfo?.path?.includes("pi-browser-harness"),
  );
}

/**
 * The harness does not expose its private client status to other extensions.
 * At startup its client has been constructed but not started, so disconnected is deterministic.
 */
export function isBrowserConnected(): boolean {
  return false;
}

export function registerBrowserAutoconnect(pi: ExtensionAPI): void {
  let done = false;

  pi.on("session_start", (event, ctx) => {
    const sessionEvent = event as SessionStartEvent;
    const sessionContext = ctx as unknown as SessionStartContext;
    if (done || sessionEvent.reason !== "startup" || !sessionContext.hasUI) return;

    done = true;
    setTimeout(() => {
      if (!isHarnessEnabled(pi) || isBrowserConnected() || !hasCommand(pi, "browser-setup")) return;

      try {
        pi.sendUserMessage("/browser-setup", { expandPromptTemplates: true });
      } catch (error) {
        sessionContext.ui.notify(`Browser auto-connect failed: ${String(error)}`, "warning");
      }
    }, 0);
  });
}

export default registerBrowserAutoconnect;
