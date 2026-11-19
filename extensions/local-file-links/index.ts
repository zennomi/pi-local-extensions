import { existsSync } from "node:fs";
import { parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GFM, parser } from "@lezer/markdown";

const markdownParser = parser.configure(GFM);

function localTarget(raw: string, cwd: string): string | undefined {
  // Lezer includes the angle brackets for CommonMark's space-friendly <destination>.
  const href = (raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw)
    .replace(/\\([!-/:-@\[-\x60{-~])/g, "$1");
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/|\\|[?#])/i.test(href) || /[\x00-\x1f\x7f]/.test(href)) return;
  const end = href.search(/[?#]/);
  const pathname = end === -1 ? href : href.slice(0, end);
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\//, "");
  } catch {
    return;
  }
  if (/[\x00-\x1f\x7f]/.test(relative) || relative.startsWith("/") || relative.includes("\\")) return;
  const rootPath = resolve(parse(cwd).root, relative);
  let path = rootPath;
  if (!existsSync(path)) {
    path = resolve(cwd, relative);
    if (!existsSync(path)) return;
  }
  const file = pathToFileURL(path);
  const url = end === -1 ? file : new URL(href.slice(end), file);
  // Parentheses are legal in URLs but can terminate a Markdown link destination.
  return url.href.replace(/[()]/g, ch => ch === "(" ? "%28" : "%29");
}

export function fixLocalLinks(markdown: string, cwd: string): string {
  if (!markdown.includes("](")) return markdown;
  const parts: string[] = [];
  let last = 0;
  markdownParser.parse(markdown).iterate({ enter(node) {
    if (node.name !== "URL" || node.node.parent?.name !== "Link") return;
    const url = localTarget(markdown.slice(node.from, node.to), cwd);
    if (url === undefined) return;
    parts.push(markdown.slice(last, node.from), url);
    last = node.to;
  } });
  return last ? parts.join("") + markdown.slice(last) : markdown;
}

export default function localFileLinks(pi: ExtensionAPI) {
  let cwd = process.cwd();
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });
  pi.registerMarkdownTransformer((markdown, ctx) =>
    ctx.isStreaming || ctx.messageType === "assistant-thinking" ? markdown : fixLocalLinks(markdown, cwd));
}
