import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentSession,
  getPackageDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const WRAPPED = Symbol.for("pi-local-extensions.export-open.wrapped");
const SESSIONS = Symbol.for("pi-local-extensions.export-open.sessions");

type SessionRefs = Set<WeakRef<AgentSession>>;

function sessionRefs(): SessionRefs {
  const shared = globalThis as typeof globalThis & { [SESSIONS]?: SessionRefs };
  return (shared[SESSIONS] ??= new Set());
}

/** Pi's extension context does not expose exportToHtml. Capture the host session instead. */
function installSessionCapture(): void {
  const prototype = AgentSession.prototype as AgentSession & { [WRAPPED]?: boolean };
  if (prototype[WRAPPED]) return;

  const original = prototype.prompt;
  const refs = sessionRefs();
  prototype.prompt = function (this: AgentSession, ...args: Parameters<AgentSession["prompt"]>) {
    // Keep only one weak reference per session, in most-recently-prompted order.
    // Neither repeated prompts nor /reload should retain sessions or grow the set indefinitely.
    for (const ref of refs) {
      const session = ref.deref();
      if (!session || session === this) refs.delete(ref);
    }
    refs.add(new WeakRef(this));
    return original.apply(this, args);
  };
  prototype[WRAPPED] = true;
}

function findSession(ctx: ExtensionCommandContext): AgentSession | undefined {
  const manager = ctx.sessionManager;
  const sessionFile = manager.getSessionFile();
  let matchingFile: AgentSession | undefined;
  for (const ref of sessionRefs()) {
    const session = ref.deref();
    if (!session) {
      sessionRefs().delete(ref);
      continue;
    }
    if (session.sessionManager === manager) return session;
    // Some Pi versions expose a read-only facade rather than the manager itself.
    if (sessionFile && session.sessionManager.getSessionFile() === sessionFile) matchingFile = session;
  }
  return matchingFile;
}

type FallbackExporter = (
  manager: ExtensionCommandContext["sessionManager"],
  state: { systemPrompt: string; tools: ReturnType<ExtensionAPI["getAllTools"]> },
  options: { outputPath: string; themeName?: string },
) => Promise<string>;

async function exportFallback(pi: ExtensionAPI, ctx: ExtensionCommandContext, outputPath: string): Promise<string> {
  // Resolve against the running host, not this repository's potentially older devDependency.
  // This internal module is not part of Pi's public package exports.
  const moduleUrl = pathToFileURL(join(getPackageDir(), "dist/core/export-html/index.js")).href;
  const module = (await import(moduleUrl)) as { exportSessionToHtml?: FallbackExporter };
  if (typeof module.exportSessionToHtml !== "function") {
    throw new Error("This Pi version does not provide the fallback HTML exporter");
  }
  return module.exportSessionToHtml(
    ctx.sessionManager,
    { systemPrompt: ctx.getSystemPrompt(), tools: pi.getAllTools() },
    { outputPath, themeName: ctx.ui.theme.name },
  );
}

async function openFile(pi: ExtensionAPI, path: string, platform: NodeJS.Platform): Promise<void> {
  let command: string;
  let args: string[];
  switch (platform) {
    case "darwin":
      command = "open";
      args = [path];
      break;
    case "linux":
      command = "xdg-open";
      args = [path];
      break;
    case "win32":
      // start is a cmd built-in. Reject shell metacharacters rather than interpreting a filename.
      if (/["%\r\n!^&|<>]/.test(path)) throw new Error("Cannot safely open this filename with cmd");
      command = "cmd";
      args = ["/d", "/c", "start", '""', path];
      break;
    default:
      throw new Error(`Opening HTML is not supported on ${platform}`);
  }
  const result = await pi.exec(command, args, { timeout: 10_000 });
  if (result.code !== 0 || result.killed) {
    throw new Error(result.stderr.trim() || `${command} failed (exit ${result.code}${result.killed ? ", killed" : ""})`);
  }
}

export interface ExportOpenDeps {
  /** Override only for tests; the command always uses literal /tmp by default. */
  outputDir?: string;
  platform?: NodeJS.Platform;
  opener?: (path: string) => Promise<void>;
}

export function createExportOpen(deps: ExportOpenDeps = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    // A host that disallows patching can still use the explicitly warned fallback.
    try {
      installSessionCapture();
    } catch {
      // Do not prevent command registration when the host prototype is frozen.
    }

    pi.registerCommand("export-open", {
      description: "Export session HTML to /tmp and open it in the default browser",
      handler: async (_args, ctx) => {
        let filePath: string;
        try {
          const sessionFile = ctx.sessionManager.getSessionFile();
          if (!sessionFile) throw new Error("Cannot export in-memory session to HTML");
          const outputPath = join(deps.outputDir ?? "/tmp", `pi-session-${basename(sessionFile, ".jsonl")}.html`);
          const session = findSession(ctx);
          if (session) {
            // Identical pipeline to interactive /export, including custom tool renderers.
            filePath = await session.exportToHtml(outputPath, { themeName: ctx.ui.theme.name });
          } else {
            ctx.ui.notify("Using fallback HTML export: custom tool renderers are unavailable.", "warning");
            filePath = await exportFallback(pi, ctx, outputPath);
          }
        } catch (error) {
          ctx.ui.notify(`Failed to export session: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }

        try {
          if (deps.opener) await deps.opener(filePath);
          else await openFile(pi, filePath, deps.platform ?? process.platform);
          ctx.ui.notify(`Session exported to: ${filePath}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `Session exported to: ${filePath}\nCould not open HTML: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      },
    });
  };
}

export default createExportOpen();
