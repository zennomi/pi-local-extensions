import { lookup } from "node:dns";
import { Agent, fetch as undiciFetch, type Dispatcher, type Response as UndiciResponse } from "undici";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { isPublicIpAddress, validateHostname, validateUrl } from "./url-safety.js";

const LOCAL_TIMEOUT_MS = 20_000;
const MAX_LOCAL_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_LOCAL_REQUESTS = 8;
const USER_AGENT = "pi-web-fetch/0.1 (+https://pi.dev)";
const GITHUB_API = "https://api.github.com";

export type LocalSource =
  | {
      kind: "markdown";
      content: string;
      sourceUrl: string;
      title?: string;
      conversionMethod: string;
      warnings: string[];
    }
  | {
      kind: "html";
      html: string;
      sourceUrl: string;
      title?: string;
      conversionMethod: string;
      warnings: string[];
    };

export interface LocalFetchOptions {
  signal?: AbortSignal;
  retainImages: boolean;
}

interface FetchedText {
  url: string;
  response: UndiciResponse;
  text: string;
}

function localError(message: string, cause?: unknown): Error {
  return new Error(`Local fallback: ${message}`, cause === undefined ? undefined : { cause });
}

function responseSizeError(): Error {
  return localError(`response exceeds the ${formatSize(MAX_LOCAL_RESPONSE_BYTES)} limit.`);
}

async function readBoundedText(response: UndiciResponse): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (Number.isSafeInteger(length) && length > MAX_LOCAL_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw responseSizeError();
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_LOCAL_RESPONSE_BYTES) {
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

function safeLookup(
  hostname: string,
  options: { family?: number | "IPv4" | "IPv6" },
  callback: (error: NodeJS.ErrnoException | Error | null, address?: string, family?: number) => void,
): void {
  const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
  lookup(hostname, { all: true, verbatim: true, family }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    try {
      if (addresses.length === 0) throw localError(`DNS returned no addresses for ${hostname}.`);
      for (const address of addresses) {
        if (!isPublicIpAddress(address.address)) {
          throw localError(`DNS resolved ${hostname} to a private, local, or reserved address.`);
        }
      }
      const selected = addresses[0]!;
      // Returning the validated address pins this connection lookup and avoids a second DNS resolution.
      callback(null, selected.address, selected.family);
    } catch (caught) {
      callback(caught instanceof Error ? caught : localError("DNS validation failed."));
    }
  });
}

const defaultDispatcher: Dispatcher = new Agent({
  // Undici's lookup overload permits an `all` result; this connector always pins one validated address.
  connect: { lookup: safeLookup as never },
  connections: 2,
  pipelining: 1,
});
let dispatcher: Dispatcher = defaultDispatcher;

/** Test seam for deterministic HTTP fixtures; production code always uses the safe default agent. */
export function setLocalDispatcherForTesting(value?: Dispatcher): void {
  dispatcher = value ?? defaultDispatcher;
}

function isRedirect(response: UndiciResponse): boolean {
  return response.status >= 300 && response.status < 400 && response.headers.has("location");
}

function isMarkdownResponse(response: UndiciResponse, url: string): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return (
    contentType.includes("text/markdown") ||
    contentType.includes("text/x-markdown") ||
    contentType.includes("application/markdown") ||
    /\.(?:md|mdx)$/i.test(new URL(url).pathname) ||
    /\/llms(?:-full)?\.txt$/i.test(new URL(url).pathname)
  );
}

function isHtmlResponse(response: UndiciResponse): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

function htmlTitle(html: string): string | undefined {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return title?.replace(/\s+/g, " ").trim() || undefined;
}

function normalizedPageKey(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  return `${url.origin}${pathname}${url.search}`;
}

function isSameOrigin(url: string, origin: string): boolean {
  return new URL(url).origin === origin;
}

function alternateMarkdownUrl(html: string, linkHeader: string | null, pageUrl: string): string | undefined {
  const candidates: string[] = [];
  const htmlLinks = html.matchAll(/<link\b[^>]*>/gi);
  for (const match of htmlLinks) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*\balternate\b/i.test(tag) || !/\btype\s*=\s*["']text\/markdown\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) candidates.push(href);
  }
  if (linkHeader && /rel\s*=\s*"?alternate"?/i.test(linkHeader) && /type\s*=\s*"?text\/markdown"?/i.test(linkHeader)) {
    const href = /<([^>]+)>/.exec(linkHeader)?.[1];
    if (href) candidates.push(href);
  }
  for (const candidate of candidates) {
    try {
      const resolved = new URL(candidate, pageUrl).toString();
      if (isSameOrigin(resolved, new URL(pageUrl).origin)) return resolved;
    } catch {
      // Ignore malformed discovery metadata.
    }
  }
  return undefined;
}

function githubRawUrl(html: string, pageUrl: string): string | undefined {
  if (new URL(pageUrl).hostname.toLowerCase() !== "github.com" || !/\/blob\//.test(new URL(pageUrl).pathname)) return undefined;
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const candidate = new URL(match[1]!, pageUrl).toString();
      if (isSameOrigin(candidate, "https://github.com") && /\/raw\//.test(new URL(candidate).pathname)) return candidate;
    } catch {
      // Ignore malformed page links.
    }
  }
  return undefined;
}

function llmsTarget(llms: string, llmsUrl: string, requestedUrl: string): string | undefined {
  const requested = normalizedPageKey(requestedUrl);
  for (const match of llms.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    try {
      const candidate = new URL(match[1]!, llmsUrl).toString();
      if (normalizedPageKey(candidate) === requested) return candidate;
    } catch {
      // Ignore malformed links in a third-party index.
    }
  }
  return undefined;
}

/** A bounded, SSRF-aware request budget shared by one fallback operation. */
class LocalRequestSession {
  #requests = 0;
  #signal?: AbortSignal;

  constructor(signal?: AbortSignal) {
    this.#signal = signal;
  }

  async get(url: string, headers: Record<string, string> = {}): Promise<FetchedText> {
    let nextUrl = validateUrl(url);
    let redirectCount = 0;
    while (true) {
      if (this.#signal?.aborted) throw localError("request was aborted.", this.#signal.reason);
      if (++this.#requests > MAX_LOCAL_REQUESTS) throw localError("request budget exceeded.");

      const timeout = AbortSignal.timeout(LOCAL_TIMEOUT_MS);
      const signal = this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout;
      let response: UndiciResponse;
      try {
        response = await undiciFetch(nextUrl, {
          dispatcher,
          redirect: "manual",
          signal,
          headers: {
            Accept: "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, */*;q=0.1",
            "User-Agent": USER_AGENT,
            ...headers,
          },
        });
      } catch (caught) {
        if (this.#signal?.aborted) throw localError("request was aborted.", caught);
        throw localError(`request to ${new URL(nextUrl).hostname} failed.`, caught);
      }

      if (isRedirect(response)) {
        if (redirectCount++ >= MAX_REDIRECTS) {
          await response.body?.cancel().catch(() => undefined);
          throw localError(`redirect limit of ${MAX_REDIRECTS} exceeded.`);
        }
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        try {
          nextUrl = validateUrl(new URL(location!, nextUrl).toString());
          validateHostname(new URL(nextUrl).hostname);
        } catch (caught) {
          throw localError("redirect target is not a permitted public URL.", caught);
        }
        continue;
      }

      return { url: nextUrl, response, text: await readBoundedText(response) };
    }
  }
}

function githubParts(url: string): string[] | undefined {
  const parsed = new URL(url);
  if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.map(decodeURIComponent) : undefined;
}

function markdownDocument(title: string, body: string, sourceUrl: string, comments: Array<{ author: string; body: string }> = []): string {
  const lines = [`# ${title}`, "", `Source: ${sourceUrl}`, "", body.trim() || "_No description provided._"];
  if (comments.length > 0) {
    lines.push("", "## Comments");
    for (const comment of comments) {
      lines.push("", `### @${comment.author}`, "", comment.body.trim() || "_No comment text provided._");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

async function githubIssueOrPull(
  session: LocalRequestSession,
  requestedUrl: string,
  parts: string[],
): Promise<LocalSource | undefined> {
  const [owner, repo, type, number] = parts;
  if (!owner || !repo || !number || (type !== "issues" && type !== "pull")) return undefined;
  const endpoint = type === "pull" ? "pulls" : "issues";
  const issue = await session.get(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${endpoint}/${encodeURIComponent(number)}`, {
    Accept: "application/vnd.github.raw+json",
  });
  if (!issue.response.ok) return undefined;
  let payload: { title?: unknown; body?: unknown; comments_url?: unknown };
  try {
    payload = JSON.parse(issue.text) as typeof payload;
  } catch {
    return undefined;
  }
  if (typeof payload.title !== "string") return undefined;

  const comments: Array<{ author: string; body: string }> = [];
  if (typeof payload.comments_url === "string") {
    const commentResponse = await session.get(`${payload.comments_url}?per_page=100`, {
      Accept: "application/vnd.github.raw+json",
    });
    if (commentResponse.response.ok) {
      try {
        const values: unknown = JSON.parse(commentResponse.text);
        if (Array.isArray(values)) {
          for (const value of values.slice(0, 100)) {
            if (typeof value !== "object" || value === null) continue;
            const comment = value as { body?: unknown; user?: { login?: unknown } };
            if (typeof comment.body === "string") {
              comments.push({ author: typeof comment.user?.login === "string" ? comment.user.login : "unknown", body: comment.body });
            }
          }
        }
      } catch {
        // The main body is still useful if a comments response is malformed.
      }
    }
  }

  return {
    kind: "markdown",
    content: markdownDocument(payload.title, typeof payload.body === "string" ? payload.body : "", requestedUrl, comments),
    sourceUrl: requestedUrl,
    title: payload.title,
    conversionMethod: `GitHub ${type === "pull" ? "pull request" : "issue"} API`,
    warnings: ["GitHub comments are limited to the first 100 comments."],
  };
}

async function githubRepositoryReadme(
  session: LocalRequestSession,
  requestedUrl: string,
  parts: string[],
): Promise<LocalSource | undefined> {
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  const response = await session.get(`${GITHUB_API}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/readme`, {
    Accept: "application/vnd.github.raw+json",
  });
  if (!response.response.ok) return undefined;
  let payload: { content?: unknown; encoding?: unknown; name?: unknown };
  try {
    payload = JSON.parse(response.text) as typeof payload;
  } catch {
    return undefined;
  }
  if (typeof payload.content !== "string" || payload.encoding !== "base64") return undefined;
  const content = Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
  return {
    kind: "markdown",
    content,
    sourceUrl: requestedUrl,
    title: typeof payload.name === "string" ? payload.name : `${owner}/${repo}`,
    conversionMethod: "GitHub README API",
    warnings: [],
  };
}

async function fetchGenericSource(session: LocalRequestSession, requestedUrl: string): Promise<LocalSource> {
  const initial = await session.get(requestedUrl);
  if (!initial.response.ok) throw localError(`received HTTP ${initial.response.status} from ${new URL(initial.url).hostname}.`);

  if (isMarkdownResponse(initial.response, initial.url)) {
    return { kind: "markdown", content: initial.text, sourceUrl: initial.url, conversionMethod: "direct Markdown", warnings: [] };
  }
  if (!isHtmlResponse(initial.response)) {
    throw localError(`received unsupported content type ${initial.response.headers.get("content-type") ?? "unknown"}.`);
  }

  const rawFile = githubRawUrl(initial.text, initial.url);
  if (rawFile) {
    try {
      const raw = await session.get(rawFile, { Accept: "text/plain, text/markdown;q=0.9" });
      const contentType = raw.response.headers.get("content-type")?.toLowerCase() ?? "";
      if (raw.response.ok && (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml"))) {
        return {
          kind: "markdown",
          content: raw.text,
          sourceUrl: raw.url,
          conversionMethod: "GitHub verified raw file",
          warnings: [],
        };
      }
    } catch {
      // Raw links are an optional enhancement; preserve the visible page.
    }
  }

  const alternate = alternateMarkdownUrl(initial.text, initial.response.headers.get("link"), initial.url);
  if (alternate) {
    try {
      const markdown = await session.get(alternate, { Accept: "text/markdown, text/plain;q=0.8" });
      if (markdown.response.ok && isMarkdownResponse(markdown.response, markdown.url)) {
        return {
          kind: "markdown",
          content: markdown.text,
          sourceUrl: markdown.url,
          conversionMethod: "discovered alternate Markdown",
          warnings: [],
        };
      }
    } catch {
      // An advertised alternate is optional; preserve the original HTML route.
    }
  }

  const root = new URL(initial.url);
  const llmsUrl = new URL("/llms.txt", root).toString();
  try {
    const llms = await session.get(llmsUrl, { Accept: "text/markdown, text/plain;q=0.8" });
    if (llms.response.ok && (isMarkdownResponse(llms.response, llms.url) || llms.response.headers.get("content-type")?.includes("text/plain"))) {
      const target = llmsTarget(llms.text, llms.url, initial.url);
      if (target && isSameOrigin(target, root.origin)) {
        const markdown = await session.get(target, { Accept: "text/markdown, text/plain;q=0.8" });
        if (markdown.response.ok && isMarkdownResponse(markdown.response, markdown.url)) {
          return {
            kind: "markdown",
            content: markdown.text,
            sourceUrl: markdown.url,
            conversionMethod: "llms.txt-discovered Markdown",
            warnings: [`Discovered via ${llms.url}.`],
          };
        }
      }
      return {
        kind: "html",
        html: initial.text,
        sourceUrl: initial.url,
        title: htmlTitle(initial.text),
        conversionMethod: "static HTML",
        warnings: [`A site index is available at ${llms.url}, but it does not map this page to Markdown.`],
      };
    }
  } catch {
    // llms.txt is entirely optional.
  }

  return {
    kind: "html",
    html: initial.text,
    sourceUrl: initial.url,
    title: htmlTitle(initial.text),
    conversionMethod: "static HTML",
    warnings: [],
  };
}

/** Fetches a local fallback source without executing page JavaScript. */
export async function fetchLocalSource(url: string, options: LocalFetchOptions): Promise<LocalSource> {
  const requestedUrl = validateUrl(url);
  const session = new LocalRequestSession(options.signal);
  const parts = githubParts(requestedUrl);
  if (parts) {
    try {
      const issue = await githubIssueOrPull(session, requestedUrl, parts);
      if (issue) return issue;
      const readme = await githubRepositoryReadme(session, requestedUrl, parts);
      if (readme) return readme;
    } catch (caught) {
      if (options.signal?.aborted) throw caught;
      // API availability/rate limits must not prevent public HTML fallback.
    }
  }
  return fetchGenericSource(session, requestedUrl);
}
