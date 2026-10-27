import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { Dispatcher } from "undici";
import { assessContent, type ContentQuality } from "./content-quality.js";
import { convertLocalSource } from "./local-convert.js";
import { fetchLocalSource } from "./local-fetch.js";
import { fetchJina, type JinaResult } from "./jina.js";
import { fetchLightpanda, LightpandaUnavailable, type LightpandaResult } from "./lightpanda.js";
import {
  ConverterError,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  errorMessage,
  hasRateLimitSignal,
  readResponseText,
  withProxyRetry,
} from "./converter-utils.js";
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

type ProviderName = "markdown.new" | "jina" | "local" | "lightpanda";

interface ProviderResult {
  markdown: string;
  sourceUrl: string;
  title?: string;
  conversionMethod?: string;
  warnings: string[];
  partial?: boolean;
  targetStatus?: number;
  usedProxy?: boolean;
  durationMs?: number;
  markdownTokens?: string;
  rateLimitRemaining?: string;
}

interface ProviderAttempt {
  provider: ProviderName;
  usedProxy?: boolean;
  ok: boolean;
  thin?: boolean;
  blocked?: boolean;
  textChars?: number;
  error?: string;
}

interface FetchWebMdDetails {
  requestedUrl: string;
  sourceUrl: string;
  title?: string;
  method: ConversionMethod;
  provider: ProviderName;
  conversionMethod?: string;
  durationMs?: number;
  markdownTokens?: string;
  rateLimitRemaining?: string;
  usedProxy?: boolean;
  fallback?: boolean;
  primaryError?: string;
  warnings?: string[];
  partial?: boolean;
  attempts: ProviderAttempt[];
  truncation?: ReturnType<typeof truncateHead>;
  fullOutputPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class MarkdownNewError extends ConverterError {
  constructor(
    message: string,
    status: number,
    readonly rateLimited: boolean,
  ) {
    super(message, "markdown.new", status, rateLimited || status === 403);
    this.name = "MarkdownNewError";
  }
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

function upstreamFailure(response: Response, payload?: MarkdownNewResponse): MarkdownNewError {
  const apiError = typeof payload?.error === "string" ? payload.error : undefined;
  const reason =
    apiError ??
    (response.status === 429
      ? "Rate limit exceeded; try again later."
      : response.statusText || "Request failed.");
  const remaining =
    response.headers.get("x-rate-limit-remaining") ?? response.headers.get("x-ratelimit-remaining");
  const rateLimited = response.status === 429 || remaining === "0" || hasRateLimitSignal(reason);
  return new MarkdownNewError(
    `markdown.new conversion failed (${response.status}): ${reason}`,
    response.status,
    rateLimited,
  );
}

async function convertToMarkdown(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  dispatcher?: Dispatcher,
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
    const request: RequestInit & { dispatcher?: Dispatcher } = {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    };
    if (dispatcher) request.dispatcher = dispatcher;

    const response = await fetch(MARKDOWN_NEW_URL, request);
    const raw = await readResponseText(response, MAX_RESPONSE_BYTES, responseSizeError);
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
    if (errorMessage(error).includes("response exceeds the")) throw error;
    if (error instanceof ConverterError) throw error;
    throw new ConverterError(
      `markdown.new request failed: ${errorMessage(error)}`,
      "markdown.new",
      0,
      true,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function convertToMarkdownWithProxyFallback(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ payload: MarkdownNewResponse; response: Response; usedProxy?: boolean }> {
  const { value, usedProxy } = await withProxyRetry(
    "markdown.new",
    (dispatcher) => convertToMarkdown(body, signal, dispatcher),
    signal,
  );
  return { ...value, usedProxy };
}

async function saveFullOutput(content: string): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-fetch-web-md-"));
  const fullOutputPath = join(tempDirectory, "page.md");
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, content, "utf8"));
  return fullOutputPath;
}

interface Candidate {
  provider: ProviderName;
  result: ProviderResult;
  quality: ContentQuality;
}

function candidateIsBetter(next: Candidate, current: Candidate | undefined): boolean {
  if (!current) return true;
  if (next.quality.blocked !== current.quality.blocked) return !next.quality.blocked;
  return next.quality.textChars > current.quality.textChars;
}

function markdownResult(
  payload: MarkdownNewResponse,
  response: Response,
  usedProxy?: boolean,
): ProviderResult {
  if (typeof payload.content !== "string" || payload.content.length === 0) {
    throw new Error("markdown.new returned no Markdown content.");
  }
  return {
    markdown: payload.content,
    sourceUrl: typeof payload.url === "string" ? payload.url : "",
    title: typeof payload.title === "string" ? payload.title : undefined,
    conversionMethod: typeof payload.method === "string" ? payload.method : undefined,
    durationMs: typeof payload.duration_ms === "number" ? payload.duration_ms : undefined,
    markdownTokens: response.headers.get("x-markdown-tokens") ?? undefined,
    rateLimitRemaining:
      response.headers.get("x-rate-limit-remaining") ??
      response.headers.get("x-ratelimit-remaining") ??
      undefined,
    warnings: [],
    usedProxy,
  };
}

function jinaResult(value: JinaResult): ProviderResult {
  return value;
}

function lightpandaResult(value: LightpandaResult): ProviderResult {
  return value;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_web_md",
    label: "Fetch Web Markdown",
    description:
      `Convert a public web URL to clean Markdown via markdown.new, Jina, a bounded static fallback, and Lightpanda for client-rendered pages. Rate-limited converter requests retry through $ROTATE_PROXY_URL when configured. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); the complete result is saved to a temporary file when truncated.`,
    promptSnippet: "Fetch a public web page as Markdown with converter, static, and Lightpanda fallbacks",
    promptGuidelines: [
      "Use fetch_web_md to read or research a public web page when its Markdown content is needed.",
      "When this tool marks a result incomplete and browser_* tools are available, use browser tools to render and inspect the page.",
    ],
    parameters: FetchWebMdParams,

    async execute(_toolCallId, params, signal) {
      const url = validateUrl(params.url);
      const method = (params.method ?? "auto") as ConversionMethod;
      const retainImages = params.retain_images ?? false;
      const attempts: ProviderAttempt[] = [];
      const errors: string[] = [];
      const providerWarnings: string[] = [];
      let candidate: Candidate | undefined;
      let markdown = "";
      let selected: Candidate | undefined;
      let incompleteWarning: string | undefined;

      const markdownProvider = async (): Promise<ProviderResult> => {
        const { payload, response, usedProxy } = await convertToMarkdownWithProxyFallback(
          { url, method, retain_images: retainImages },
          signal,
        );
        const result = markdownResult(payload, response, usedProxy);
        if (!result.sourceUrl) result.sourceUrl = url;
        return result;
      };
      const jinaProvider = async (): Promise<ProviderResult> => jinaResult(await fetchJina(url, retainImages, signal));
      const localProvider = async (): Promise<ProviderResult> => {
        const source = await fetchLocalSource(url, { signal, retainImages });
        const local = convertLocalSource(source, retainImages);
        const warnings = [...local.warnings];
        if (method === "browser") {
          warnings.push("The local fallback cannot execute JavaScript, despite method: browser.");
        }
        if (local.partial) {
          warnings.push(
            browserAdvice(pi) ??
              "Static extraction may be incomplete because this page needs client-side rendering.",
          );
        }
        let content = local.content;
        if (warnings.length > 0) {
          content += `\n> **${local.partial ? "Incomplete static fallback" : "Fallback note"}:** ${warnings.join(" ")}\n`;
        }
        return {
          markdown: content,
          sourceUrl: local.sourceUrl,
          title: local.title,
          conversionMethod: local.conversionMethod,
          warnings,
          partial: local.partial,
        };
      };
      const lightpandaProvider = async (): Promise<ProviderResult> =>
        lightpandaResult(await fetchLightpanda(url, retainImages, signal));

      const providers: Array<[ProviderName, () => Promise<ProviderResult>]> =
        method === "browser"
          ? [
              ["markdown.new", markdownProvider],
              ["lightpanda", lightpandaProvider],
              ["jina", jinaProvider],
              ["local", localProvider],
            ]
          : [
              ["markdown.new", markdownProvider],
              ["jina", jinaProvider],
              ["local", localProvider],
              ["lightpanda", lightpandaProvider],
            ];

      for (const [provider, fetchProvider] of providers) {
        if (signal?.aborted) throw new Error("fetch_web_md request was aborted.", { cause: signal.reason });
        try {
          const result = await fetchProvider();
          const quality = assessContent(result.markdown, {
            partial: result.partial,
            targetStatus: result.targetStatus,
          });
          const attempt: ProviderAttempt = {
            provider,
            usedProxy: result.usedProxy,
            ok: true,
            thin: quality.thin,
            blocked: quality.blocked,
            textChars: quality.textChars,
          };
          attempts.push(attempt);
          const nextCandidate = { provider, result, quality };
          if (candidateIsBetter(nextCandidate, candidate)) candidate = nextCandidate;
          if (!quality.thin && !quality.blocked) {
            selected = nextCandidate;
            break;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          const message = errorMessage(error);
          attempts.push({ provider, ok: false, error: message });
          errors.push(message);
          if (error instanceof LightpandaUnavailable) providerWarnings.push(message);
          if (provider === "markdown.new" && !shouldUseLocalFallback(error, signal)) throw error;
        }
      }

      selected ??= candidate;
      if (!selected) {
        const advice = browserAdvice(pi);
        const primary = errors[0] ?? "All web Markdown providers failed.";
        const rest = errors.slice(1);
        throw new Error(
          `${primary}${rest.length > 0 ? ` Fallback attempts failed: ${rest.join(" | ")}` : ""}${advice ? ` ${advice}` : ""}`,
        );
      }

      markdown = selected.result.markdown;
      const selectedQuality = selected.quality;
      const warnings = [...providerWarnings, ...selected.result.warnings];
      if (selectedQuality.thin || selectedQuality.blocked) {
        incompleteWarning =
          `All available converters returned thin or blocked content; selected the best available ${selected.provider} result (${selectedQuality.textChars} meaningful characters).`;
        warnings.push(incompleteWarning);
        const advice = browserAdvice(pi);
        if (advice) warnings.push(advice);
        markdown += `\n> **Incomplete fetch:** ${warnings.join(" ")}\n`;
      }

      const firstError = errors[0];
      const details: FetchWebMdDetails = {
        requestedUrl: url,
        sourceUrl: selected.result.sourceUrl || url,
        title: selected.result.title,
        method,
        provider: selected.provider,
        conversionMethod: selected.result.conversionMethod,
        durationMs: selected.result.durationMs,
        markdownTokens: selected.result.markdownTokens,
        rateLimitRemaining: selected.result.rateLimitRemaining,
        usedProxy: selected.result.usedProxy,
        fallback: selected.provider !== "markdown.new",
        primaryError: firstError,
        warnings: warnings.length > 0 ? warnings : undefined,
        partial: Boolean(selected.result.partial || selectedQuality.thin || selectedQuality.blocked),
        attempts,
      };
      if (incompleteWarning && !details.warnings?.includes(incompleteWarning)) {
        details.warnings = [...(details.warnings ?? []), incompleteWarning];
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
