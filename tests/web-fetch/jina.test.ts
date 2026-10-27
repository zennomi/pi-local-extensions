import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJina } from "../../extensions/web-fetch/jina.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function successfulResponse(content = "# Jina page\n\nUseful content.") {
  return {
    code: 200,
    status: 20000,
    data: {
      title: "Jina page",
      url: "https://example.com/final",
      content,
    },
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
  vi.unstubAllEnvs();
});

describe("Jina provider", () => {
  it("parses a successful JSON response", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(successfulResponse())));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchJina("https://example.com/", false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://r.jina.ai/https://example.com/");
    expect(request).toMatchObject({ method: "GET", headers: { Accept: "application/json", "X-Retain-Images": "none" } });
    expect(result).toMatchObject({
      markdown: "# Jina page\n\nUseful content.",
      title: "Jina page",
      sourceUrl: "https://example.com/final",
      conversionMethod: "Jina Reader",
    });
  });

  it("reports a target-site 403 as blocked without proxy retry", async () => {
    vi.stubEnv("ROTATE_PROXY_URL", "http://proxy.example.test:8080");
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          code: 200,
          data: {
            title: "",
            url: "https://www.reddit.com/post",
            content: "You've been blocked by network security.",
            warning: "Target URL returned error 403: Forbidden",
            httpStatus: 403,
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchJina("https://www.reddit.com/post", false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ targetStatus: 403, warnings: ["Target URL returned error 403: Forbidden"] });
  });

  it("retries a Jina rate limit through ROTATE_PROXY_URL", async () => {
    vi.stubEnv("ROTATE_PROXY_URL", "http://proxy.example.test:8080");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Rate limit exceeded" }, 429))
      .mockResolvedValueOnce(jsonResponse(successfulResponse("# Via proxy\n")));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchJina("https://example.com/", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, proxyRequest] = fetchMock.mock.calls[1] as [string, RequestInit & { dispatcher?: unknown }];
    expect(proxyRequest.dispatcher).toBeDefined();
    expect((proxyRequest.headers as Record<string, string>)["X-Retain-Images"]).toBeUndefined();
    expect(result).toMatchObject({ markdown: "# Via proxy\n", usedProxy: true });
  });

  it("sends JINA_API_KEY when configured", async () => {
    vi.stubEnv("JINA_API_KEY", "secret-key");
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(successfulResponse())));
    vi.stubGlobal("fetch", fetchMock);

    await fetchJina("https://example.com/", true);

    const request = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(request.headers).toMatchObject({ Authorization: "Bearer secret-key" });
    expect((request.headers as Record<string, string>)["X-Retain-Images"]).toBeUndefined();
  });

  it("distinguishes timeout from caller cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", abortingFetch());

    const timeout = fetchJina("https://example.com/", false);
    const timeoutExpectation = expect(timeout).rejects.toThrow("timed out after 30s");
    await vi.advanceTimersByTimeAsync(30_000);
    await timeoutExpectation;

    const controller = new AbortController();
    const aborted = fetchJina("https://example.com/", false, controller.signal);
    controller.abort("caller stopped the request");
    await expect(aborted).rejects.toThrow("request was aborted");
  });

  it("rejects oversized declared responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { headers: { "content-length": String(10 * 1024 * 1024 + 1) } }))),
    );

    await expect(fetchJina("https://example.com/", false)).rejects.toThrow(
      "jina response exceeds the 10.0MB limit",
    );
  });
});
