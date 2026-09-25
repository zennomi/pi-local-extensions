import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { validateUrl } from "../fetch-web-md.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: { url: string; method?: "auto" | "ai" | "browser"; retain_images?: boolean },
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
}

function getTool(): RegisteredTool {
  let registered: RegisteredTool | undefined;
  extension({
    registerTool(tool: unknown) {
      registered = tool as RegisteredTool;
    },
  } as ExtensionAPI);
  if (!registered) throw new Error("Extension did not register its tool.");
  return registered;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function successfulPayload(content = "# Example\n") {
  return {
    success: true,
    url: "https://example.com/final",
    title: "Example",
    content,
    method: "Cloudflare Workers AI",
    duration_ms: 12,
  };
}

function abortingFetch() {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetch_web_md extension", () => {
  it("registers the documented fetch_web_md tool", () => {
    const tool = getTool();

    expect(tool).toMatchObject({
      name: "fetch_web_md",
      label: "Fetch Web Markdown",
      promptSnippet: "Fetch a public web page as clean Markdown via markdown.new",
      promptGuidelines: [
        "Use fetch_web_md to read or research a public web page when its Markdown content is needed.",
      ],
    });
    expect(tool.description).toContain("Output is truncated");
    expect(tool.parameters).toBeDefined();
  });

  it("posts default options and returns Markdown plus metadata", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(successfulPayload(), 200, {
          "x-markdown-tokens": "42",
          "x-rate-limit-remaining": "499",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTool().execute("call-1", { url: "https://example.com" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(url).toBe("https://markdown.new/");
    expect(request).toMatchObject({
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    expect(JSON.parse(request.body as string)).toEqual({
      url: "https://example.com/",
      method: "auto",
      retain_images: false,
    });
    expect(result.content).toEqual([{ type: "text", text: "# Example\n" }]);
    expect(result.details).toMatchObject({
      requestedUrl: "https://example.com/",
      sourceUrl: "https://example.com/final",
      title: "Example",
      method: "auto",
      conversionMethod: "Cloudflare Workers AI",
      durationMs: 12,
      markdownTokens: "42",
      rateLimitRemaining: "499",
    });
  });

  it("passes explicit conversion options", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(successfulPayload())));
    vi.stubGlobal("fetch", fetchMock);

    await getTool().execute("call-1", {
      url: "https://example.com/path",
      method: "browser",
      retain_images: true,
    });

    const request = (fetchMock.mock.calls as unknown as [unknown, RequestInit][])[0]?.[1];
    expect(JSON.parse(request.body as string)).toEqual({
      url: "https://example.com/path",
      method: "browser",
      retain_images: true,
    });
  });

  it.each([
    ["ftp://example.com", "http or https"],
    ["https://user:secret@example.com", "must not contain credentials"],
    ["https://localhost", "public hostname"],
    ["https://app.localhost", "public hostname"],
    ["https://service.local", "public hostname"],
    ["https://service.internal", "public hostname"],
    ["https://intranet", "public hostname"],
    ["http://127.0.0.1", "private, local, or reserved IP"],
    ["http://[::1]", "private, local, or reserved IP"],
    ["http://[::ffff:192.168.1.1]", "private, local, or reserved IP"],
    ["http://2130706433", "private, local, or reserved IP"],
  ])("rejects unsafe URL %s", (url, message) => {
    expect(() => validateUrl(url)).toThrow(message);
  });

  it("accepts public DNS names and public IPv4 literals", () => {
    expect(validateUrl("https://example.com")).toBe("https://example.com/");
    expect(validateUrl("https://8.8.8.8/path")).toBe("https://8.8.8.8/path");
  });

  it("surfaces HTTP failures and rate limiting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: "Daily limit reached" }, 429))),
    );

    await expect(getTool().execute("call-1", { url: "https://example.com" })).rejects.toThrow(
      "markdown.new conversion failed (429): Daily limit reached",
    );
  });

  it("rejects malformed JSON and malformed successful payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("not json"))));
    await expect(getTool().execute("call-1", { url: "https://example.com" })).rejects.toThrow(
      "invalid JSON response",
    );

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([]))));
    await expect(getTool().execute("call-2", { url: "https://example.com" })).rejects.toThrow(
      "markdown.new conversion failed (200)",
    );
  });

  it("reports a missing Markdown field", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ success: true }))));

    await expect(getTool().execute("call-1", { url: "https://example.com" })).rejects.toThrow(
      "returned no Markdown content",
    );
  });

  it("distinguishes timeout from caller cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", abortingFetch());

    const timeout = getTool().execute("call-timeout", { url: "https://example.com" });
    const timeoutExpectation = expect(timeout).rejects.toThrow("timed out after 30s");
    await vi.advanceTimersByTimeAsync(30_000);
    await timeoutExpectation;

    const controller = new AbortController();
    const aborted = getTool().execute("call-abort", { url: "https://example.com" }, controller.signal);
    controller.abort("caller stopped the request");
    await expect(aborted).rejects.toThrow("request was aborted");
  });

  it("rejects oversized declared and chunked responses", async () => {
    const tooLarge = (10 * 1024 * 1024 + 1).toString();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { headers: { "content-length": tooLarge } }))),
    );
    await expect(getTool().execute("call-length", { url: "https://example.com" })).rejects.toThrow(
      "response exceeds the 10.0MB limit",
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(10 * 1024 * 1024 + 1)));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(stream))));
    await expect(getTool().execute("call-stream", { url: "https://example.com" })).rejects.toThrow(
      "response exceeds the 10.0MB limit",
    );
  });

  it("truncates tool output and preserves the complete Markdown in a temp file", async () => {
    const markdown = Array.from({ length: 2_001 }, (_, index) => `line ${index + 1}`).join("\n");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(successfulPayload(markdown)))));

    const result = await getTool().execute("call-1", { url: "https://example.com" });
    const outputPath = result.details.fullOutputPath;

    expect(result.content[0].text).toContain("Output truncated: showing 2000 of 2001 lines");
    expect(result.details.truncation).toMatchObject({
      truncated: true,
      totalLines: 2_001,
      outputLines: 2_000,
    });
    expect(outputPath).toEqual(expect.any(String));
    await expect(readFile(outputPath as string, "utf8")).resolves.toBe(markdown);
    await rm(dirname(outputPath as string), { recursive: true, force: true });
  });
});
