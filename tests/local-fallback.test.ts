import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgent } from "undici";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../fetch-web-md.js";
import { convertLocalSource } from "../local-convert.js";
import { setLocalDispatcherForTesting } from "../local-fetch.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface RegisteredTool {
  execute: (
    toolCallId: string,
    params: { url: string; method?: "auto" | "ai" | "browser"; retain_images?: boolean },
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
}

const agents: MockAgent[] = [];

function getTool(activeTools: string[] = []): RegisteredTool {
  let registered: RegisteredTool | undefined;
  extension({
    registerTool(tool: unknown) {
      registered = tool as RegisteredTool;
    },
    getActiveTools() {
      return activeTools;
    },
  } as ExtensionAPI);
  if (!registered) throw new Error("Extension did not register its tool.");
  return registered;
}

function useLocalHttp(origin: string) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  setLocalDispatcherForTesting(agent);
  return agent.get(origin);
}

function primaryFailure() {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }))));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  setLocalDispatcherForTesting();
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

describe("local fallback", () => {
  it("uses direct Markdown after the markdown.new service fails", async () => {
    primaryFailure();
    useLocalHttp("https://example.com")
      .intercept({ path: "/guide", method: "GET" })
      .reply(200, "# Local guide\n\nUseful content.\n", { headers: { "content-type": "text/markdown" } });

    const result = await getTool().execute("fallback-1", { url: "https://example.com/guide" });

    expect(result.content[0]!.text).toContain("# Local guide");
    expect(result.details).toMatchObject({ fallback: true, conversionMethod: "direct Markdown", sourceUrl: "https://example.com/guide" });
  });

  it("follows a same-origin alternate Markdown representation", async () => {
    primaryFailure();
    const pool = useLocalHttp("https://docs.example.com");
    pool
      .intercept({ path: "/install", method: "GET" })
      .reply(200, '<html><head><link rel="alternate" type="text/markdown" href="/install.md"></head><body><main>Install</main></body></html>', {
        headers: { "content-type": "text/html" },
      });
    pool
      .intercept({ path: "/install.md", method: "GET" })
      .reply(200, "# Install\n\nRun the command.\n", { headers: { "content-type": "text/markdown" } });

    const result = await getTool().execute("fallback-2", { url: "https://docs.example.com/install" });

    expect(result.content[0]!.text).toContain("Run the command.");
    expect(result.details).toMatchObject({ fallback: true, conversionMethod: "discovered alternate Markdown" });
  });

  it("uses GitHub's raw issue API and includes bounded comments", async () => {
    primaryFailure();
    const api = useLocalHttp("https://api.github.com");
    api
      .intercept({ path: "/repos/acme/widget/issues/7", method: "GET" })
      .reply(200, JSON.stringify({ title: "Bug report", body: "Issue **body**", comments_url: "https://api.github.com/repos/acme/widget/issues/7/comments" }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/repos/acme/widget/issues/7/comments?per_page=100", method: "GET" })
      .reply(200, JSON.stringify([{ body: "Fixed in #8", user: { login: "maintainer" } }]), {
        headers: { "content-type": "application/json" },
      });

    const result = await getTool().execute("fallback-3", { url: "https://github.com/acme/widget/issues/7" });

    expect(result.content[0]!.text).toContain("# Bug report");
    expect(result.content[0]!.text).toContain("### @maintainer");
    expect(result.details).toMatchObject({ fallback: true, conversionMethod: "GitHub issue API" });
  });

  it("marks a client-side shell incomplete and recommends available browser tools", async () => {
    primaryFailure();
    const pool = useLocalHttp("https://app.example.com");
    pool
      .intercept({ path: "/", method: "GET" })
      .reply(200, "<html><head><title>App</title><script id=\"__NEXT_DATA__\">{}</script></head><body><div id=\"root\">Loading</div></body></html>", {
        headers: { "content-type": "text/html" },
      });
    pool.intercept({ path: "/llms.txt", method: "GET" }).reply(404, "not found", { headers: { "content-type": "text/plain" } });

    const result = await getTool(["browser_navigate", "browser_snapshot"]).execute("fallback-4", { url: "https://app.example.com" });

    expect(result.content[0]!.text).toContain("Incomplete static fallback");
    expect(result.content[0]!.text).toContain("Use the available browser_* tools");
    expect(result.details).toMatchObject({ fallback: true, partial: true });
  });

  it("strips unsafe links and removes images unless requested", () => {
    const source = {
      kind: "html" as const,
      html: '<html><head><title>Example</title></head><body><main><p><a href="javascript:alert(1)">bad</a> <a href="/good">good</a></p><img src="/image.png" alt="diagram"></main></body></html>',
      sourceUrl: "https://example.com/page",
      conversionMethod: "static HTML",
      warnings: [],
    };

    const withoutImages = convertLocalSource(source, false);
    const withImages = convertLocalSource(source, true);

    expect(withoutImages.content).not.toContain("image.png");
    expect(withoutImages.content).not.toContain("javascript:");
    expect(withImages.content).toContain("https://example.com/image.png");
  });
});
