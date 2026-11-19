import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Query Launch Services for this file, not an extension/MIME allowlist. No GUI or Apple Events.
const queryEditor = `ObjC.import("AppKit"); function run(args) {
  const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(args[0]));
  if (!app.isNil() && ObjC.unwrap($.NSBundle.bundleWithURL(app).bundleIdentifier) === "com.google.antigravity-ide") return ObjC.unwrap(app.path);
  return "";
}`;

export async function editorForFile(file: string): Promise<string | undefined> {
  if (!(await stat(file)).isFile()) return;
  const {stdout} = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", queryEditor, file], {timeout: 4000});
  const app = stdout.trimEnd();
  if (app) return join(app, "Contents/Resources/app/bin/antigravity-ide");
}

async function launch(cli: string, args: string[]) {
  // An integrated terminal's IPC hook could route this request into a different window.
  const env = { ...process.env };
  delete env.VSCODE_IPC_HOOK_CLI;
  await exec(cli, args, { cwd: "/", env, timeout: 20000 });
}

/** Return false to delegate unmodified to Pi. Look up the application only after a click. */
export async function openProjectFile(target: string, cwd: string, lookup = editorForFile, run = launch): Promise<boolean> {
  if (!/^file:\/\//i.test(target)) return false;
  let file: string, cli: string | undefined;
  try {
    file = fileURLToPath(target); // rejects remote hosts and encoded separators on macOS
    cli = await lookup(file);
  } catch { return false; }
  if (!cli) return false;
  // A single request names both the project and the file. Existing folder windows win;
  // --new-window prevents replacing an unrelated workspace when the folder isn't open.
  await run(cli, ["--new-window", cwd, file]);
  return true;
}

// Pi 1.5.x does not expose a link-click event. A zero-row widget supplies the live TUI
// reference; its proxy forwards property reads/writes to the current renderer. Track the
// hook on that renderer, not on the proxy, so switching fullscreen on/off also works.
const marker = Symbol("local-file-links/installed");
type Host = { openUrl?: (target: string) => void; [marker]?: object };
export function workspaceLinkWidget(tui: object, cwd: string, warn: (message: string) => void, route = openProjectFile) {
  const host = tui as Host;
  let undo: (() => void) | undefined;
  function attach() {
    if (host[marker] || typeof host.openUrl !== "function") return;
    const original = host.openUrl;
    const owner = {};
    host.openUrl = target => {
      if (!/^file:\/\//i.test(target)) return original(target);
      void route(target, cwd).then(handled => { if (!handled) original(target); }).catch(() => {
        warn("Antigravity IDE could not open this file in the Pi workspace.");
      });
    };
    host[marker] = owner;
    undo = () => {
      if (host[marker] === owner) {
        host.openUrl = original;
        // Assignment (not deleteProperty) is forwarded by Pi's live TUI proxy.
        host[marker] = undefined;
      }
    };
  }
  attach();
  return { render() { attach(); return []; }, invalidate() {}, dispose() { undo?.(); } };
}
