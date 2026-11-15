import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createExportOpen, type ExportOpenDeps } from "../../extensions/export-open/index.js";

const WRAPPED = Symbol.for("pi-local-extensions.export-open.wrapped");
const SESSIONS = Symbol.for("pi-local-extensions.export-open.sessions");
const originalPrompt = AgentSession.prototype.prompt;
const dirs: string[] = [];
const sessions: AgentSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
  AgentSession.prototype.prompt = originalPrompt;
  Reflect.deleteProperty(AgentSession.prototype, WRAPPED);
  Reflect.deleteProperty(globalThis, SESSIONS);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "export-open-"));
  dirs.push(dir);
  return dir;
}

function htmlData(path: string) {
  const html = readFileSync(path, "utf8");
  const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
  expect(encoded).toBeDefined();
  return JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
}

async function fixture(deps: ExportOpenDeps = {}, inMemory = false, themeName = "light") {
  initTheme(themeName);
  const cwd = tempDir();
  const agentDir = tempDir();
  const outputDir = tempDir();
  const opener = vi.fn(async (_path: string) => {});
  const notify = vi.fn();
  const onError = vi.fn();
  const faux = fauxProvider({ provider: "export-test", models: [{ id: "export-model" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("export_test_tool", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Export me, including the custom tool.")]),
  ]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ theme: "dark" });
  const factory = createExportOpen({ outputDir, opener, ...deps });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [(pi) => {
      factory(pi);
      pi.on("session_start", () => pi.setActiveTools(["export_test_tool"]));
      pi.registerTool({
        name: "export_test_tool",
        label: "Export test",
        description: "A custom tool with HTML renderers",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "raw result" }], details: {} };
        },
        renderCall(_args, theme) {
          return { render: () => [theme.fg("accent", "Custom call")], invalidate() {} };
        },
        renderResult(_result, { expanded }, theme) {
          return { render: () => [theme.fg("success", expanded ? "Custom expanded" : "Custom collapsed")], invalidate() {} };
        },
      });
    }],
  });
  await resourceLoader.reload();
  const sessionManager = inMemory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(agentDir, "sessions"));
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager, sessionManager,
  });
  sessions.push(session);
  await session.bindExtensions({
    uiContext: { notify, theme: { name: themeName } } as unknown as ExtensionUIContext,
    onError,
  });
  const path = join(outputDir, `pi-session-${basename(sessionManager.getSessionFile() ?? "in-memory", ".jsonl")}.html`);
  return { session, sessionManager, outputDir, path, opener, notify, onError };
}

function commandHarness(deps: ExportOpenDeps = {}) {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
  const pi = {
    registerCommand: vi.fn((_name, options) => { handler = options.handler; }),
    exec,
    getAllTools: () => [{ name: "test_tool", description: "Tool metadata", parameters: { type: "object" } }],
  } as unknown as ExtensionAPI;
  createExportOpen(deps)(pi);
  const outputDir = deps.outputDir ?? tempDir();
  const manager = SessionManager.create(outputDir, join(outputDir, "sessions"));
  manager.appendMessage({ role: "user", content: "Fallback conversation", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage([fauxText("Fallback answer")]));
  const notify = vi.fn();
  const ctx = {
    sessionManager: manager,
    getSystemPrompt: () => "Fallback system prompt",
    ui: { notify, theme: { name: "light" } },
  } as unknown as ExtensionCommandContext;
  const path = join(outputDir, `pi-session-${basename(manager.getSessionFile()!, ".jsonl")}.html`);
  return { pi, exec, manager, notify, ctx, path, run: (args = "") => handler(args, ctx) };
}

describe("export-open integration", () => {
  it.each(["light", "dark"])("matches built-in export byte-for-byte with %s theme and custom tool renderers", async (themeName) => {
    const { session, path, opener, notify, onError, outputDir } = await fixture({}, false, themeName);
    await session.prompt("Use the test tool");
    const entryCount = session.sessionManager.getEntries().length;
    opener.mockImplementation(async (filePath) => { expect(existsSync(filePath)).toBe(true); });
    await session.prompt("/export-open ignored-argument");

    expect(onError).not.toHaveBeenCalled();
    expect(opener).toHaveBeenCalledExactlyOnceWith(path);
    expect(notify.mock.calls).toEqual([[`Session exported to: ${path}`, "info"]]);
    expect(session.sessionManager.getEntries()).toHaveLength(entryCount); // No model turn or transcript change.
    const expected = join(outputDir, "built-in.html");
    await session.exportToHtml(expected, { themeName });
    expect(readFileSync(path).equals(readFileSync(expected))).toBe(true);
    const data = htmlData(path);
    expect(data.systemPrompt).toBeTruthy();
    expect(data.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "export_test_tool" })]));
    expect(JSON.stringify(data.renderedTools)).toContain("Custom call");
    expect(JSON.stringify(data.renderedTools)).toContain("Custom expanded");
    expect(JSON.stringify(data.renderedTools)).toContain("Custom collapsed");
  }, 20_000);

  it("overwrites the same path and does not stack wrappers on reload", async () => {
    const { session, path, outputDir, opener, onError } = await fixture();
    await session.prompt("Use the tool");
    await session.prompt("/export-open");
    const previous = readFileSync(path, "utf8");
    const wrapper = AgentSession.prototype.prompt;
    await session.reload();
    expect(AgentSession.prototype.prompt).toBe(wrapper);
    session.sessionManager.appendCustomEntry("after-reload", { updated: true });
    await session.prompt("/export-open");
    expect(onError).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).not.toBe(previous);
    expect(readdirSync(outputDir)).toEqual([basename(path)]);
    expect(opener.mock.calls).toEqual([[path], [path]]);
    const refs = Reflect.get(globalThis, SESSIONS) as Set<WeakRef<AgentSession>>;
    expect([...refs].filter((ref) => ref.deref() === session)).toHaveLength(1);
  }, 20_000);

  it("uses literal /tmp by default, regardless of TMPDIR", async () => {
    const { session, sessionManager, opener } = await fixture({ outputDir: undefined });
    const expected = `/tmp/pi-session-${basename(sessionManager.getSessionFile()!, ".jsonl")}.html`;
    const exporter = vi.spyOn(session, "exportToHtml").mockResolvedValue(expected);
    await session.prompt("/export-open");
    expect(exporter).toHaveBeenCalledExactlyOnceWith(expected, { themeName: "light" });
    expect(opener).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("reports an in-memory session without trying to open it", async () => {
    const { session, opener, notify, outputDir } = await fixture({}, true);
    await session.prompt("/export-open");
    expect(notify).toHaveBeenCalledExactlyOnceWith("Failed to export session: Cannot export in-memory session to HTML", "error");
    expect(opener).not.toHaveBeenCalled();
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("reports an empty file-backed session without opening a stale file or falling back", async () => {
    const { session, opener, notify } = await fixture();
    await session.prompt("/export-open");
    expect(notify).toHaveBeenCalledExactlyOnceWith("Failed to export session: Nothing to export yet - start a conversation first", "error");
    expect(opener).not.toHaveBeenCalled();
  });

  it("keeps the export and reports its path when the opener throws", async () => {
    const { session, path, notify } = await fixture({ opener: async () => { throw new Error("browser unavailable"); } });
    await session.prompt("Use the tool");
    await session.prompt("/export-open");
    expect(existsSync(path)).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith(`Session exported to: ${path}\nCould not open HTML: browser unavailable`, "warning");
  });
});

describe("fallback and platform opening", () => {
  it("warns and uses the host's real exporter if the command has no captured session", async () => {
    const opener = vi.fn(async (_path: string) => {});
    const { run, path, notify, manager, pi } = commandHarness({ outputDir: tempDir(), opener });
    await run();
    expect(opener).toHaveBeenCalledExactlyOnceWith(path);
    expect(notify.mock.calls).toEqual([
      ["Using fallback HTML export: custom tool renderers are unavailable.", "warning"],
      [`Session exported to: ${path}`, "info"],
    ]);
    const data = htmlData(path);
    expect(data.systemPrompt).toBe("Fallback system prompt");
    expect(data.entries).toEqual(manager.getEntries());
    expect(data.tools).toEqual(pi.getAllTools());
    expect(data.renderedTools).toBeUndefined();
  });

  it.each([
    ["darwin", "open", []],
    ["linux", "xdg-open", []],
    ["win32", "cmd", ["/d", "/c", "start", '""']],
  ] as const)("opens via %s's default application only after exporting", async (platform, command, prefix) => {
    const { run, path, exec } = commandHarness({ outputDir: tempDir(), platform });
    exec.mockImplementation(async () => {
      expect(existsSync(path)).toBe(true);
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    await run();
    expect(exec).toHaveBeenCalledExactlyOnceWith(command, [...prefix, path], { timeout: 10_000 });
  });

  it("warns with the saved path when the opener exits nonzero", async () => {
    const { run, path, exec, notify } = commandHarness({ outputDir: tempDir(), platform: "linux" });
    exec.mockResolvedValue({ stdout: "", stderr: "no display", code: 1, killed: false });
    await run();
    expect(existsSync(path)).toBe(true);
    expect(notify).toHaveBeenLastCalledWith(`Session exported to: ${path}\nCould not open HTML: no display`, "warning");
  });

  it("reports fallback export failure without invoking the opener", async () => {
    const outputDir = tempDir();
    const { run, exec, notify, manager } = commandHarness({ outputDir, platform: "darwin" });
    rmSync(manager.getSessionFile()!);
    await run();
    expect(notify).toHaveBeenLastCalledWith("Failed to export session: Nothing to export yet - start a conversation first", "error");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("prompt wrapper", () => {
  it("preserves this, argument identity, return promise, and rejection", async () => {
    const result = Promise.resolve();
    const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockReturnValue(result);
    const { pi } = commandHarness({ outputDir: tempDir() });
    const wrapper = AgentSession.prototype.prompt;
    createExportOpen()(pi);
    expect(AgentSession.prototype.prompt).toBe(wrapper);
    const session = Object.create(AgentSession.prototype) as AgentSession;
    const options = { expandPromptTemplates: false };
    expect(session.prompt("hello", options)).toBe(result);
    expect(prompt).toHaveBeenCalledExactlyOnceWith("hello", options);
    expect(prompt.mock.contexts[0]).toBe(session);
    const error = new Error("original prompt failure");
    prompt.mockRejectedValue(error);
    await expect(session.prompt("fail")).rejects.toBe(error);
  });
});
