import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent } from "undici";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../extensions/web-fetch/index.js";
import { setLightpandaRunnerForTesting } from "../../extensions/web-fetch/lightpanda.js";
import { setLocalDispatcherForTesting } from "../../extensions/web-fetch/local-fetch.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface RegisteredTool {
  execute(
    toolCallId: string,
    params: { url: string; method?: "auto" | "ai" | "browser"; retain_images?: boolean },
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

const agents: MockAgent[] = [];

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function markdownPayload(content: string) {
  return {
    success: true,
    url: "https://example.com/final",
    title: "Example",
    content,
    method: "test markdown",
  };
}

function jinaPayload(content: string) {
  return {
    code: 200,
    status: 20000,
    data: { title: "Jina", url: "https://example.com/final", content },
  };
}

function useLocalHttp(origin: string) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  setLocalDispatcherForTesting(agent);
  return agent.get(origin);
}

beforeEach(() => {
  vi.stubEnv("ROTATE_PROXY_URL", "");
  vi.stubEnv("PI_WEB_FETCH_LIGHTPANDA", "0");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setLocalDispatcherForTesting();
  setLightpandaRunnerForTesting();
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

describe("provider pipeline", () => {
  it("uses Jina when markdown.new returns thin content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(markdownPayload("# Tiny")))
      .mockResolvedValueOnce(jsonResponse(jinaPayload(`# Full Jina page\n\n${"Useful content. ".repeat(40)}`)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTool().execute("pipeline-jina", { url: "https://example.com/" });

    expect(result.details).toMatchObject({ provider: "jina", fallback: true });
    expect(result.details.attempts).toEqual([
      expect.objectContaining({ provider: "markdown.new", ok: true, thin: true }),
      expect.objectContaining({ provider: "jina", ok: true, thin: false, blocked: false }),
    ]);
    expect(result.content[0]!.text).toContain("Full Jina page");
  });

  it("uses Lightpanda after remote converters and static extraction are incomplete", async () => {
    const pool = useLocalHttp("https://app.example.com");
    pool
      .intercept({ path: "/", method: "GET" })
      .reply(200, '<html><head><title>App</title><script id="__NEXT_DATA__">{}</script></head><body><div id="root">Loading</div></body></html>', {
        headers: { "content-type": "text/html" },
      });
    pool.intercept({ path: "/llms.txt", method: "GET" }).reply(404, "not found", {
      headers: { "content-type": "text/plain" },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: "markdown unavailable" }, 503))
        .mockResolvedValueOnce(jsonResponse({ error: "jina unavailable" }, 503)),
    );
    vi.stubEnv("LIGHTPANDA_PATH", process.execPath);
    vi.stubEnv("PI_WEB_FETCH_LIGHTPANDA", "1");
    setLightpandaRunnerForTesting(async () => ({
      stdout: JSON.stringify({
        url: "https://app.example.com/",
        http_status: 200,
        content: `# Rendered app\n\n${"Rendered content. ".repeat(40)}`,
        error: null,
        bot_challenge: null,
      }),
      stderr: "",
      exitCode: 0,
    }));

    const result = await getTool().execute("pipeline-lightpanda", { url: "https://app.example.com/" });

    expect(result.details).toMatchObject({ provider: "lightpanda", fallback: true });
    expect(result.details.attempts).toEqual([
      expect.objectContaining({ provider: "markdown.new", ok: false }),
      expect.objectContaining({ provider: "jina", ok: false }),
      expect.objectContaining({ provider: "local", ok: true, blocked: true }),
      expect.objectContaining({ provider: "lightpanda", ok: true, blocked: false }),
    ]);
    expect(result.content[0]!.text).toContain("Rendered app");
  });

  it("returns the best available candidate with an incomplete warning", async () => {
    const pool = useLocalHttp("https://tiny.example.com");
    pool.intercept({ path: "/page", method: "GET" }).reply(200, "# Local", {
      headers: { "content-type": "text/markdown" },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(markdownPayload("# Markdown")))
        .mockResolvedValueOnce(jsonResponse(jinaPayload("# Jina"))),
    );

    const result = await getTool().execute("pipeline-incomplete", { url: "https://tiny.example.com/page" });

    expect(result.details).toMatchObject({ provider: "markdown.new", partial: true });
    expect(result.details.warnings).toEqual(expect.arrayContaining([expect.stringContaining("All available converters")]))
    expect(result.content[0]!.text).toContain("Incomplete fetch");
  });

  it("stops immediately when the caller aborts", async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = getTool().execute("pipeline-abort", { url: "https://example.com/" }, controller.signal);
    controller.abort("stop");

    await expect(pending).rejects.toThrow("request was aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
