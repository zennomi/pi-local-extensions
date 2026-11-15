import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import cliproxyToolAlias, {
  aliasCandidates,
  fixAssistantToolNames,
  resolveAliasedToolName,
} from "../../extensions/cliproxy-tool-alias/index.js";
import { BIP39_WORDS } from "../../extensions/cliproxy-tool-alias/bip39-words.js";

const KNOWN = new Set(["read", "bash", "edit", "write", "browser_click", "fetch_web_md", "mcp__github__create_issue"]);

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    provider: "cliproxyapi",
    model: "claude-opus-5-5",
    api: "cliproxyapi-codex-responses",
    usage: {} as AssistantMessage["usage"],
    stopReason: "toolUse",
    timestamp: 0,
    ...overrides,
  };
}

describe("BIP-39 wordlist", () => {
  it("has the 2048 words CLIProxyAPI uses", () => {
    expect(BIP39_WORDS).toHaveLength(2048);
    expect(BIP39_WORDS[0]).toBe("abandon");
    expect(BIP39_WORDS[2044]).toBe("zebra");
    expect(BIP39_WORDS).toContain("mandate");
  });
});

describe("resolveAliasedToolName", () => {
  it.each([
    ["zebra_write", "write"],
    ["mandate_bash", "bash"],
    ["fun_read", "read"],
    ["acoustic_edit", "edit"],
    ["mcp__ocean_tiger__zebra_write", "write"],
    ["ocean_tiger__zebra_write", "write"],
    ["mcp__ocean_tiger__ocean_tiger__mandate_bash", "bash"],
    ["mcp__ocean_tiger__write", "write"],
    ["fun_browser_click", "browser_click"],
    ["web_fetch_web_md", "fetch_web_md"],
    ["mcp__ocean_tiger__mcp__github__create_issue", "mcp__github__create_issue"],
  ])("%s -> %s", (alias, expected) => {
    expect(resolveAliasedToolName(alias, KNOWN)).toBe(expected);
  });

  it.each([
    ["write"],
    ["browser_click"],
    ["mcp__github__create_issue"],
  ])("leaves known tool %s untouched", (name) => {
    expect(resolveAliasedToolName(name, KNOWN)).toBeUndefined();
  });

  it.each([
    ["my_bash"], // "my" is not a BIP-39 word
    ["zebra_deploy"], // no tool named deploy
    ["zebra"],
    ["zebra_"],
    ["mcp__ocean_tiger__"],
    ["write_file"],
  ])("does not guess for %s", (name) => {
    expect(resolveAliasedToolName(name, KNOWN)).toBeUndefined();
  });

  it("prefers the most specific candidate", () => {
    expect(aliasCandidates("mcp__ocean_tiger__zebra_write")).toEqual([
      "mcp__ocean_tiger__zebra_write",
      "ocean_tiger__zebra_write",
      "tiger__zebra_write",
      "zebra_write",
      "write",
    ]);
  });
});

describe("fixAssistantToolNames", () => {
  it("rewrites only aliased tool calls and keeps ids, arguments and other blocks", () => {
    const message = assistant({
      content: [
        { type: "text", text: "Writing the file." },
        { type: "toolCall", id: "call_1", name: "zebra_write", arguments: { path: "a.txt", content: "x" } },
        { type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.txt" } },
      ],
    });

    const result = fixAssistantToolNames(message, KNOWN);

    expect(result?.fixes).toEqual([{ from: "zebra_write", to: "write" }]);
    expect(result?.message.content).toEqual([
      { type: "text", text: "Writing the file." },
      { type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.txt", content: "x" } },
      { type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.txt" } },
    ]);
    expect(message.content[1]).toMatchObject({ name: "zebra_write" });
  });

  it("returns undefined when nothing needs fixing", () => {
    const message = assistant({
      content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }],
    });
    expect(fixAssistantToolNames(message, KNOWN)).toBeUndefined();
  });
});

describe("message_end handler", () => {
  function setup(activeTools = [...KNOWN]) {
    let handler: ((event: any, ctx: any) => unknown) | undefined;
    const notifications: string[] = [];
    const pi = {
      on(name: string, fn: (event: any, ctx: any) => unknown) {
        if (name === "message_end") handler = fn;
      },
      getActiveTools: () => activeTools,
    };
    cliproxyToolAlias(pi as never);
    const ctx = { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } };
    return { run: (message: unknown) => handler!({ type: "message_end", message }, ctx), notifications };
  }

  it("replaces aliased names on cliproxyapi assistant messages", () => {
    const { run, notifications } = setup();
    const result = run(assistant({
      content: [{ type: "toolCall", id: "c", name: "mandate_bash", arguments: { command: "ls" } }],
    })) as { message: AssistantMessage };

    expect(result.message.content[0]).toMatchObject({ name: "bash", arguments: { command: "ls" } });
    expect(notifications).toEqual(["Restored proxy-aliased tool name: mandate_bash → bash"]);
  });

  it("ignores other providers", () => {
    const { run } = setup();
    expect(run(assistant({
      provider: "anthropic",
      content: [{ type: "toolCall", id: "c", name: "zebra_write", arguments: {} }],
    }))).toBeUndefined();
  });

  it("ignores non-assistant messages", () => {
    const { run } = setup();
    expect(run({ role: "user", content: "zebra_write", timestamp: 0 })).toBeUndefined();
  });

  it("only maps to active tools", () => {
    const { run } = setup(["read"]);
    expect(run(assistant({
      content: [{ type: "toolCall", id: "c", name: "zebra_write", arguments: {} }],
    }))).toBeUndefined();
  });
});

describe("integration with AgentSession", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function runSession(withExtension: boolean) {
    const cwd = mkdtempSync(join(tmpdir(), "cliproxy-tool-alias-"));
    const agentDir = mkdtempSync(join(tmpdir(), "cliproxy-tool-alias-agent-"));
    dirs.push(cwd, agentDir);

    const faux = fauxProvider({
      provider: "cliproxyapi",
      models: [{ id: "claude-opus-5-5" }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("zebra_write", { path: "out.txt", content: "hello from zebra" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);

    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      extensionFactories: withExtension ? [cliproxyToolAlias] : [],
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader,
      settingsManager,
      sessionManager,
    });

    try {
      await session.prompt("write a file");
    } finally {
      session.dispose();
    }

    const messages = sessionManager.getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry as { message: any }).message);
    const toolCall = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .find((block: any) => block.type === "toolCall");
    const toolResult = messages.find((m) => m.role === "toolResult");
    return { cwd, toolCall, toolResult };
  }

  it("reproduces the bug without the extension", async () => {
    const { cwd, toolCall, toolResult } = await runSession(false);

    expect(existsSync(join(cwd, "out.txt"))).toBe(false);
    expect(toolCall).toMatchObject({ name: "zebra_write" });
    expect(toolResult).toMatchObject({ toolName: "zebra_write", isError: true });
    expect(JSON.stringify(toolResult.content)).toContain("Tool zebra_write not found");
  }, 20_000);

  it("executes the real write tool when the model calls zebra_write", async () => {
    const { cwd, toolCall, toolResult } = await runSession(true);

    expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("hello from zebra");
    expect(toolCall).toMatchObject({ name: "write" });
    expect(toolResult).toMatchObject({ toolName: "write", isError: false });
  }, 20_000);
});
