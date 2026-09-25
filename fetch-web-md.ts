import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ipaddr from "ipaddr.js";
import { StringEnum, Type } from "@earendil-works/pi-ai";
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
const MAX_URL_LENGTH = 8_192;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

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
  truncation?: ReturnType<typeof truncateHead>;
  fullOutputPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicIpAddress(hostname: string): boolean {
  if (!ipaddr.isValid(hostname)) return false;
  return ipaddr.process(hostname).range() === "unicast";
}

function validateHostname(hostname: string): void {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
  const ipLiteral = normalizedHostname.replace(/^\[|\]$/g, "");

  if (ipaddr.isValid(ipLiteral)) {
    if (!isPublicIpAddress(ipLiteral)) {
      throw new Error("url must not target a private, local, or reserved IP address.");
    }
    return;
  }

  if (
    normalizedHostname === "localhost" ||
    LOCAL_HOST_SUFFIXES.some((suffix) => normalizedHostname.endsWith(suffix)) ||
    !normalizedHostname.includes(".")
  ) {
    throw new Error("url must include a public hostname.");
  }
}

export function validateUrl(value: string): string {
  if (value.length > MAX_URL_LENGTH) {
    throw new Error(`URL exceeds the ${MAX_URL_LENGTH}-character limit.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must be a valid absolute http(s) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use the http or https protocol.");
  }
  if (!parsed.hostname) {
    throw new Error("url must include a hostname.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("url must not contain credentials.");
  }

  validateHostname(parsed.hostname);
  return parsed.toString();
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
      `Convert a public web URL to clean Markdown via markdown.new. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); the complete result is saved to a temporary file when truncated.`,
    promptSnippet: "Fetch a public web page as clean Markdown via markdown.new",
    promptGuidelines: [
      "Use fetch_web_md to read or research a public web page when its Markdown content is needed.",
    ],
    parameters: FetchWebMdParams,

    async execute(_toolCallId, params, signal) {
      const url = validateUrl(params.url);
      const method = (params.method ?? "auto") as ConversionMethod;
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

      const sourceUrl = typeof payload.url === "string" ? payload.url : url;
      const truncation = truncateHead(payload.content, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const details: FetchWebMdDetails = {
        requestedUrl: url,
        sourceUrl,
        title: typeof payload.title === "string" ? payload.title : undefined,
        method,
        conversionMethod: typeof payload.method === "string" ? payload.method : undefined,
        durationMs: typeof payload.duration_ms === "number" ? payload.duration_ms : undefined,
        markdownTokens: response.headers.get("x-markdown-tokens") ?? undefined,
        rateLimitRemaining: response.headers.get("x-rate-limit-remaining") ?? undefined,
      };

      let text = truncation.content;
      if (truncation.truncated) {
        const fullOutputPath = await saveFullOutput(payload.content);
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
