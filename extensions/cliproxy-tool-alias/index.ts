import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BIP39_WORDS } from "./bip39-words.js";

/**
 * CLIProxyAPI's Claude cloaking renames every client tool to
 * `mcp__<word>_<word>__<word>_<original>` (BIP-39 words) before sending it upstream,
 * and maps the name back on the response. The reverse map only matches the full alias
 * (or one with a recognised `mcp__<server>__` prefix). When Claude drops or mangles the
 * prefix, e.g. `zebra_write` or `mandate_bash`, the proxy forwards the name unchanged and
 * Pi fails with "Tool zebra_write not found". This extension restores the original name.
 */

/** Provider ids routed through CLIProxyAPI (see ~/.pi/agent/cliproxyapi.json `providerId`). */
export const CLIPROXY_PROVIDERS: ReadonlySet<string> = new Set(["cliproxyapi"]);

const WORDS = new Set(BIP39_WORDS);

/** Candidate names derived from a possibly aliased tool name, most specific first. */
export function aliasCandidates(name: string): string[] {
  const tails = [name];
  for (let i = name.indexOf("__"); i !== -1; i = name.indexOf("__", i + 2)) {
    const tail = name.slice(i + 2);
    if (tail) tails.push(tail);
  }

  const candidates: string[] = [];
  for (const tail of tails) {
    candidates.push(tail);
    const separator = tail.indexOf("_");
    if (separator > 0 && WORDS.has(tail.slice(0, separator))) {
      const original = tail.slice(separator + 1);
      if (original) candidates.push(original);
    }
  }
  return [...new Set(candidates)];
}

/**
 * Returns the known tool name an unknown, aliased name refers to, or undefined when the
 * name is already known or no candidate matches.
 */
export function resolveAliasedToolName(name: string, known: ReadonlySet<string>): string | undefined {
  if (known.has(name)) return undefined;
  for (const candidate of aliasCandidates(name)) {
    if (candidate !== name && known.has(candidate)) return candidate;
  }
  return undefined;
}

export type ToolNameFix = { from: string; to: string };

/** Rewrites unknown aliased tool-call names. Returns undefined when nothing changed. */
export function fixAssistantToolNames(
  message: AssistantMessage,
  known: ReadonlySet<string>,
): { message: AssistantMessage; fixes: ToolNameFix[] } | undefined {
  const fixes: ToolNameFix[] = [];
  const content = message.content.map((block) => {
    if (block.type !== "toolCall") return block;
    const to = resolveAliasedToolName(block.name, known);
    if (!to) return block;
    fixes.push({ from: block.name, to });
    return { ...block, name: to } satisfies ToolCall;
  });
  return fixes.length > 0 ? { message: { ...message, content }, fixes } : undefined;
}

export default function cliproxyToolAlias(pi: ExtensionAPI): void {
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    if (!CLIPROXY_PROVIDERS.has(message.provider)) return;

    const result = fixAssistantToolNames(message, new Set(pi.getActiveTools()));
    if (!result) return;

    if (ctx.hasUI) {
      const summary = result.fixes.map(({ from, to }) => `${from} → ${to}`).join(", ");
      ctx.ui.notify(`Restored proxy-aliased tool name: ${summary}`, "info");
    }
    return { message: result.message };
  });
}
