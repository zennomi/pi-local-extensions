import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLightpanda,
  LightpandaUnavailable,
  resolveLightpandaBinary,
  setLightpandaRunnerForTesting,
} from "../../extensions/web-fetch/lightpanda.js";

function output(content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    url: "https://example.com/page?solution=secret&jsc_token=token",
    http_status: 200,
    content,
    error: null,
    bot_challenge: null,
    ...extra,
  });
}

function setupBinary() {
  vi.stubEnv("LIGHTPANDA_PATH", process.execPath);
  vi.stubEnv("PI_WEB_FETCH_LIGHTPANDA", "1");
  vi.stubEnv("ROTATE_PROXY_URL", "");
}

afterEach(() => {
  setLightpandaRunnerForTesting();
  vi.unstubAllEnvs();
});

describe("Lightpanda provider", () => {
  it("resolves the configured executable and dumps Markdown", async () => {
    setupBinary();
    const content = `# Rendered page\n\n${"Useful rendered content. ".repeat(30)}`;
    const runner = vi.fn(async (_binary, args, options) => ({
      stdout: output(content),
      stderr: "",
      exitCode: 0,
    }));
    setLightpandaRunnerForTesting(runner);

    const result = await fetchLightpanda("https://example.com/page", false);

    expect(await resolveLightpandaBinary()).toBe(process.execPath);
    expect(runner).toHaveBeenCalledTimes(1);
    const [, args, options] = runner.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args).toContain("--block-private-networks");
    expect(args).toContain("--strip-mode");
    expect(args).toContain("ui");
    expect(options.env.LIGHTPANDA_DISABLE_TELEMETRY).toBe("true");
    expect(result).toMatchObject({
      title: "Rendered page",
      sourceUrl: "https://example.com/page",
      conversionMethod: "Lightpanda browser dump",
    });
    expect(result.markdown).not.toContain("solution=");
    expect(result.markdown).not.toContain("jsc_token=");
  });

  it("does not pass the UI strip mode when retaining images", async () => {
    setupBinary();
    const runner = vi.fn(async (_binary, args) => ({ stdout: output(`# Page\n\n${"text ".repeat(100)}`), stderr: "", exitCode: 0 }));
    setLightpandaRunnerForTesting(runner);

    await fetchLightpanda("https://example.com/page", true);

    const args = (runner.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toContain("clutter");
    expect(args).not.toContain("ui");
  });

  it("skips cleanly when no binary is available", async () => {
    vi.stubEnv("LIGHTPANDA_PATH", "/definitely/missing/lightpanda");
    vi.stubEnv("PATH", "");
    vi.stubEnv("ROTATE_PROXY_URL", "");

    await expect(fetchLightpanda("https://example.com/", false)).rejects.toBeInstanceOf(LightpandaUnavailable);
  });

  it("surfaces a JSON process error", async () => {
    setupBinary();
    setLightpandaRunnerForTesting(async () => ({
      stdout: output("", { error: "CouldntConnect" }),
      stderr: "failed to connect",
      exitCode: 1,
    }));

    await expect(fetchLightpanda("https://example.com/", false)).rejects.toThrow(
      "Lightpanda fetch failed: CouldntConnect",
    );
  });

  it("retries a failed process through the configured proxy and redacts it", async () => {
    setupBinary();
    vi.stubEnv("ROTATE_PROXY_URL", "http://user:secret@proxy.example.test:8080");
    const runner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: output("", { error: "CouldntConnect" }),
        stderr: "proxy=http://user:secret@proxy.example.test:8080",
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: output(`# Via proxy\n\n${"Useful content. ".repeat(30)}`),
        stderr: "",
        exitCode: 0,
      });
    setLightpandaRunnerForTesting(runner);

    const result = await fetchLightpanda("https://example.com/", false);

    expect(runner).toHaveBeenCalledTimes(2);
    const proxyArgs = (runner.mock.calls[1] as unknown as [string, string[]])[1];
    expect(proxyArgs).toContain("--http-proxy");
    expect(proxyArgs).toContain("http://user:secret@proxy.example.test:8080/");
    expect(result.usedProxy).toBe(true);
    expect(result.markdown).not.toContain("secret");
  });

  it("marks bot challenges and target HTTP errors as partial", async () => {
    setupBinary();
    setLightpandaRunnerForTesting(async () => ({
      stdout: output("# Access denied\n\nChecking your browser", { http_status: 403, bot_challenge: "cloudflare" }),
      stderr: "",
      exitCode: 0,
    }));

    const result = await fetchLightpanda("https://example.com/", false);

    expect(result).toMatchObject({ targetStatus: 403, partial: true });
    expect(result.warnings).toContain("Lightpanda reported a bot challenge.");
  });
});
