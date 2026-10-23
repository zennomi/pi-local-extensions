import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { convertLocalSource } from "./local-convert.js";
import { fetchLocalSource } from "./local-fetch.js";
import { validateUrl } from "./url-safety.js";
export { validateUrl } from "./url-safety.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const MARKDOWN_NEW_URL = "https://markdown.new/";
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const FetchWebMdParams = Type.Object({
  url: Type.String({
    description: "Public http(s) URL to convert to clean Markdown",
  }),
  method: Type.Optional(
    StringEnum(["auto", "ai", "browser"] as const, {
      description:
        "Conversion strategy: auto (default), ai, or browser for JavaScript-heavy pages",
    }),
  ),
  retain_images: Type.Optional(
    Type.Boolean({
      description: "Keep image links in the converted Markdown (default: false)",
    }),
  ),
});

type ConversionMethod = "auto" | "ai" | "browser";

interface MarkdownNewResponse {
  success?: unknown;
  url?: unknown;
  title?: unknown;
  content?: unknown;
  error?: unknown;
  method?: unknown;
  duration_ms?: unknown;
}

interface FetchWebMdDetails {
  requestedUrl: string;
  sourceUrl: string;
  title?: string;
  method: ConversionMethod;
  conversionMethod?: string;
  durationMs?: number;
  markdownTokens?: string;
  rateLimitRemaining?: string;
  fallback?: boolean;
  primaryError?: string;
  warnings?: string[];
  partial?: boolean;
  truncation?: ReturnType<typeof truncateHead>;
  fullOutputPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldUseLocalFallback(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  return !errorMessage(error).includes("response exceeds the 10.0MB limit");
}

function browserAdvice(pi: ExtensionAPI): string | undefined {
  const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  return activeTools.some((name) => name.startsWith("browser_"))
    ? "Use the available browser_* tools to render and inspect the page."
    : undefined;
}

function responseSizeError(): Error {
  return new Error(
    `markdown.new response exceeds the ${formatSize(MAX_RESPONSE_BYTES)} limit.`,
  );
}

async function readResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw responseSizeError();
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw responseSizeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function parsePayload(raw: string, response: Response): MarkdownNewResponse | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : undefined;
  } catch {
    if (response.ok) {
      throw new Error(
        `markdown.new returned an invalid JSON response (${response.status} ${response.statusText}).`,
      );
    }
    return undefined;
  }
}

function upstreamFailure(response: Response, payload?: MarkdownNewResponse): Error {
  const apiError = typeof payload?.error === "string" ? payload.error : undefined;
  const reason =
    apiError ??
    (response.status === 429
      ? "Rate limit exceeded; try again later."
      : response.statusText || "Request failed.");
  return new Error(`markdown.new conversion failed (${response.status}): ${reason}`);
}

async function convertToMarkdown(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ payload: MarkdownNewResponse; response: Response }> {
  if (signal?.aborted) {
    throw new Error("markdown.new request was aborted.", { cause: signal.reason });
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(MARKDOWN_NEW_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await readResponseText(response);
    const payload = parsePayload(raw, response);

    if (!response.ok || payload?.success !== true) {
      throw upstreamFailure(response, payload);
    }

    return { payload, response };
  } catch (error) {
    if (timedOut) {
      throw new Error(`markdown.new request timed out after ${TIMEOUT_MS / 1_000}s.`, {
        cause: error,
      });
    }
    if (signal?.aborted) {
      throw new Error("markdown.new request was aborted.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function saveFullOutput(content: string): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-fetch-web-md-"));
  const fullOutputPath = join(tempDirectory, "page.md");
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, content, "utf8"));
  return fullOutputPath;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_web_md",
    label: "Fetch Web Markdown",
    description:
      `Convert a public web URL to clean Markdown via markdown.new, with a bounded static local fallback when that service fails. JavaScript-rendered pages may be incomplete; use browser_* tools when advised. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); the complete result is saved to a temporary file when truncated.`,
    promptSnippet: "Fetch a public web page as clean Markdown with markdown.new and static fallback",
    promptGuidelines: [
      "Use fetch_web_md to read or research a public web page when its Markdown content is needed.",
      "When this tool marks a result incomplete and browser_* tools are available, use browser tools for the rendered page.",
    ],
    parameters: FetchWebMdParams,

    async execute(_toolCallId, params, signal) {
      const url = validateUrl(params.url);
      const method = (params.method ?? "auto") as ConversionMethod;
      let markdown: string;
      let details: FetchWebMdDetails;
      try {
        const { payload, response } = await convertToMarkdown(
          {
            url,
            method,
            retain_images: params.retain_images ?? false,
          },
          signal,
        );
        if (typeof payload.content !== "string" || payload.content.length === 0) {
          throw new Error("markdown.new returned no Markdown content.");
        }
        markdown = payload.content;
        details = {
          requestedUrl: url,
          sourceUrl: typeof payload.url === "string" ? payload.url : url,
          title: typeof payload.title === "string" ? payload.title : undefined,
          method,
          conversionMethod: typeof payload.method === "string" ? payload.method : undefined,
          durationMs: typeof payload.duration_ms === "number" ? payload.duration_ms : undefined,
          markdownTokens: response.headers.get("x-markdown-tokens") ?? undefined,
          rateLimitRemaining: response.headers.get("x-rate-limit-remaining") ?? undefined,
        };
      } catch (primaryError) {
        if (!shouldUseLocalFallback(primaryError, signal)) throw primaryError;
        try {
          const source = await fetchLocalSource(url, {
            signal,
            retainImages: params.retain_images ?? false,
          });
          const local = convertLocalSource(source, params.retain_images ?? false);
          const warnings = [...local.warnings];
          if (method === "browser") {
            warnings.push("The local fallback cannot execute JavaScript, despite method: browser.");
          }
          if (local.partial) {
            warnings.push(browserAdvice(pi) ?? "Static extraction may be incomplete because this page needs client-side rendering.");
          }
          markdown = local.content;
          if (warnings.length > 0) {
            markdown += `\n> **${local.partial ? "Incomplete static fallback" : "Fallback note"}:** ${warnings.join(" ")}\n`;
          }
          details = {
            requestedUrl: url,
            sourceUrl: local.sourceUrl,
            title: local.title,
            method,
            conversionMethod: local.conversionMethod,
            fallback: true,
            primaryError: errorMessage(primaryError),
            warnings,
            partial: local.partial,
          };
        } catch (fallbackError) {
          const advice = browserAdvice(pi);
          throw new Error(
            `${errorMessage(primaryError)} Local fallback failed: ${errorMessage(fallbackError)}${advice ? ` ${advice}` : ""}`,
            { cause: fallbackError },
          );
        }
      }

      const truncation = truncateHead(markdown, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncation.content;
      if (truncation.truncated) {
        const fullOutputPath = await saveFullOutput(markdown);
        details.truncation = truncation;
        details.fullOutputPath = fullOutputPath;
        text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
      }

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  });
}
