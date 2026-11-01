import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import emptyResponseRetry, {
  CONTENT_FILTER_FALLBACK,
  FALLBACK_MODELS,
  isContentFilterError,
  isEmptyAssistantMessage,
  isSubagentSession,
  isTerminatedSubagentError,
  isWebSocketIdleTimeoutError,
  hasFinalAnswerForSubagentDone,
  MAX_SUBAGENT_DONE_BLOCKS,
  SUBAGENT_DONE_BLOCK_REASON,
  SUBAGENT_ENV,
  TERMINATED_SUBAGENT_FALLBACK,
} from "../../extensions/empty-response-retry/index.js";

const GUARD = Symbol.for("pi-local-extensions/empty-response-retry");

type Model = { provider: string; id: string };

type Handler = (event: any, ctx: any) => unknown;

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    provider: "cliproxyapi",
    model: "original",
    api: "openai-completions",
    usage: {} as AssistantMessage["usage"],
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function setup(options: { availableFallbacks?: string[] } = {}) {
  let currentModel: Model = { provider: "cliproxyapi", id: "original" };
  const modelMap = new Map<string, Model>([
    ["cliproxyapi/original", currentModel],
    ...[...FALLBACK_MODELS, TERMINATED_SUBAGENT_FALLBACK]
      .filter(({ id }) => options.availableFallbacks?.includes(id) ?? true)
      .map(({ provider, id }) => [
        `${provider}/${id}`,
        { provider, id },
      ] as const),
  ]);
  const handlers = new Map<string, Handler>();
  const setModelCalls: Model[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    async setModel(model: Model) {
      setModelCalls.push(model);
      currentModel = model;
      return true;
    },
  };

  const ctx = {
    hasUI: true,
    ui: {
      notify(notification: string, level: string) {
        notifications.push({ message: notification, level });
      },
    },
    get model() {
      return currentModel;
    },
    modelRegistry: {
      find(provider: string, id: string) {
        return modelMap.get(`${provider}/${id}`);
      },
    },
  };

  emptyResponseRetry(pi as any);

  return {
    ctx,
    handlers,
    notifications,
    setModelCalls,
    setUserModel(model: Model) {
      currentModel = model;
    },
    get currentModel() {
      return currentModel;
    },
  };
}

function turn(messageValue: AssistantMessage, messageEntryId = "assistant-entry") {
  return {
    type: "turn_end",
    message: messageValue,
    messageEntryId,
    toolResults: [],
    toolResultEntryIds: [],
    entries: [],
    continue: false,
    context: {} as never,
    outcome: "completed",
    turnIndex: 0,
  };
}

describe("isSubagentSession", () => {
  it.each([
    [undefined, false],
    ["", false],
    [" \n\t", false],
    ["test-subagent", true],
    [" test-subagent \n", true],
  ])("returns %s → %s", (id, expected) => {
    expect(isSubagentSession({ [SUBAGENT_ENV]: id })).toBe(expected);
  });

  it("ignores other subagent metadata without an id", () => {
    expect(isSubagentSession({
      PI_SUBAGENT_SESSION: "/tmp/child.jsonl",
      PI_SUBAGENT_NAME: "child",
      PI_SUBAGENT_AUTO_EXIT: "1",
    })).toBe(false);
  });
});

describe("isEmptyAssistantMessage", () => {
  it.each([
    ["empty content", []],
    ["whitespace text", [{ type: "text", text: " \n\t" }]],
    ["thinking only", [{ type: "thinking", thinking: "internal reasoning" }]],
  ])("returns true for %s", (_name, content) => {
    expect(isEmptyAssistantMessage(message({ content: content as never }))).toBe(true);
  });

  it("returns false when text is present", () => {
    expect(isEmptyAssistantMessage(message({ content: [{ type: "text", text: "answer" }] }))).toBe(false);
  });

  it("returns false when a tool call is present", () => {
    expect(
      isEmptyAssistantMessage(
        message({
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        }),
      ),
    ).toBe(false);
  });

  it.each(["error", "aborted", "length"] as const)("returns false for stopReason=%s", (stopReason) => {
    expect(isEmptyAssistantMessage(message({ stopReason }))).toBe(false);
  });
});

describe("terminated subagent errors", () => {
  it("recognizes a terminated subagent session error", () => {
    expect(
      isTerminatedSubagentError(
        message({
          stopReason: "error",
          errorMessage:
            "~/.pi/agent/sessions/--Users-tuananhnguyendang-Me-cypherman--/2026-10-25T17 (subagent_done terminated)",
        }),
      ),
    ).toBe(true);
  });

  it("recognizes the subagent_done tool terminating with an error", () => {
    expect(
      isTerminatedSubagentError(
        message({
          content: [{ type: "toolCall", id: "done-1", name: "subagent_done", arguments: {} }],
          stopReason: "error",
          errorMessage: "terminated",
        }),
      ),
    ).toBe(true);
  });

  it("recognizes a WebSocket idle timeout error", () => {
    expect(
      isWebSocketIdleTimeoutError(
        message({
          stopReason: "error",
          errorMessage: "WebSocket idle timeout after 300000ms",
        }),
      ),
    ).toBe(true);
  });

  it("recognizes a content filter error", () => {
    expect(
      isContentFilterError(
        message({
          stopReason: "error",
          errorMessage: "Response incomplete: content_filter",
          rawStopReason: "incomplete.content_filter",
        }),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated errors as terminated subagent errors", () => {
    expect(
      isTerminatedSubagentError(
        message({ stopReason: "error", errorMessage: "provider request failed" }),
      ),
    ).toBe(false);
  });
});

describe("empty response retry extension", () => {
  let originalSubagentId: string | undefined;
  let originalSimulation: string | undefined;

  beforeEach(() => {
    originalSubagentId = process.env.PI_SUBAGENT_ID;
    originalSimulation = process.env.PI_EMPTY_RETRY_SIMULATE;
    process.env.PI_SUBAGENT_ID = "test-subagent";
    delete (globalThis as Record<PropertyKey, unknown>)[GUARD];
    delete process.env.PI_EMPTY_RETRY_SIMULATE;
  });

  afterEach(() => {
    if (originalSubagentId === undefined) delete process.env.PI_SUBAGENT_ID;
    else process.env.PI_SUBAGENT_ID = originalSubagentId;
    if (originalSimulation === undefined) delete process.env.PI_EMPTY_RETRY_SIMULATE;
    else process.env.PI_EMPTY_RETRY_SIMULATE = originalSimulation;
  });

  it.each(["subagent", "main"])("switches to Opus for a terminated subagent error in %s sessions", async (session) => {
    if (session === "main") delete process.env.PI_SUBAGENT_ID;
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    const result = (await handler(
      turn(
        message({
          stopReason: "error",
          errorMessage:
            "~/.pi/agent/sessions/--Users-tuananhnguyendang-Me-cypherman--/2026-10-25T17 (subagent_done terminated)",
        }),
        "terminated",
      ),
      runtime.ctx,
    )) as any;

    expect(result).toMatchObject({ continue: true });
    expect(result.entries).toEqual([
      { type: "context_edit", targetId: "terminated", replacement: null },
    ]);
    expect(runtime.currentModel.id).toBe("claude-opus-5-5");
    expect(runtime.notifications.at(-1)?.message).toContain("cliproxyapi/claude-opus-5-5");
  });

  it.each(["subagent", "main"])("switches to Opus for a WebSocket idle timeout in %s sessions", async (session) => {
    if (session === "main") delete process.env.PI_SUBAGENT_ID;
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    const result = (await handler(
      turn(
        message({
          stopReason: "error",
          errorMessage: "WebSocket idle timeout after 300000ms",
        }),
        "websocket-timeout",
      ),
      runtime.ctx,
    )) as any;

    expect(result).toMatchObject({ continue: true });
    expect(result.entries).toEqual([
      { type: "context_edit", targetId: "websocket-timeout", replacement: null },
    ]);
    expect(runtime.currentModel.id).toBe("claude-opus-5-5");
    expect(runtime.notifications.at(-1)?.message).toContain("WebSocket idle timeout");
  });

  it.each(["subagent", "main"])("switches from Opus to Gemini for any subsequent error in %s sessions", async (session) => {
    if (session === "main") delete process.env.PI_SUBAGENT_ID;
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    await handler(
      turn(
        message({
          stopReason: "error",
          errorMessage: "WebSocket idle timeout after 300000ms",
        }),
        "timeout",
      ),
      runtime.ctx,
    );

    const result = (await handler(
      turn(
        message({
          model: TERMINATED_SUBAGENT_FALLBACK.id,
          stopReason: "error",
          errorMessage: "provider request failed",
        }),
        "opus-error",
      ),
      runtime.ctx,
    )) as any;

    expect(result).toMatchObject({ continue: true });
    expect(runtime.currentModel.id).toBe(CONTENT_FILTER_FALLBACK.id);
    expect(runtime.setModelCalls.map(({ id }) => id)).toEqual([
      TERMINATED_SUBAGENT_FALLBACK.id,
      CONTENT_FILTER_FALLBACK.id,
    ]);
  });

  it.each([
    ["empty content", []],
    ["whitespace text", [{ type: "text", text: " \n\t" }]],
    ["thinking only", [{ type: "thinking", thinking: "internal reasoning" }]],
  ])("does not retry %s in main sessions", async (_name, content) => {
    delete process.env.PI_SUBAGENT_ID;
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    for (let i = 0; i < 4; i++) {
      expect(await handler(turn(message({ content: content as never })), runtime.ctx)).toBeUndefined();
    }

    expect(runtime.currentModel.id).toBe("original");
    expect(runtime.setModelCalls).toHaveLength(0);
    expect(runtime.notifications).toHaveLength(0);
  });

  it("ignores simulation in main sessions", async () => {
    delete process.env.PI_SUBAGENT_ID;
    process.env.PI_EMPTY_RETRY_SIMULATE = "1";
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    const result = await handler(
      turn(message({ content: [{ type: "text", text: "visible answer" }] })),
      runtime.ctx,
    );

    expect(result).toBeUndefined();
    expect(runtime.currentModel.id).toBe("original");
    expect(runtime.setModelCalls).toHaveLength(0);
    expect(runtime.notifications).toHaveLength(0);
  });

  it("does not retry an empty response after an error fallback in main sessions and restores the model", async () => {
    delete process.env.PI_SUBAGENT_ID;
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    await handler(
      turn(message({ stopReason: "error", errorMessage: "WebSocket idle timeout after 300000ms" })),
      runtime.ctx,
    );
    const result = await handler(
      turn(message({ model: TERMINATED_SUBAGENT_FALLBACK.id })),
      runtime.ctx,
    );

    expect(result).toBeUndefined();
    expect(runtime.setModelCalls.map(({ id }) => id)).toEqual([TERMINATED_SUBAGENT_FALLBACK.id]);
    expect(runtime.notifications).toHaveLength(1);

    await runtime.handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, runtime.ctx);
    expect(runtime.currentModel.id).toBe("original");
    expect(runtime.setModelCalls.map(({ id }) => id)).toEqual([TERMINATED_SUBAGENT_FALLBACK.id, "original"]);
  });

  it("keeps ordinary errors out of the retry flow", async () => {
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    const result = await handler(
      turn(message({ stopReason: "error", errorMessage: "provider request failed" })),
      runtime.ctx,
    );

    expect(result).toBeUndefined();
    expect(runtime.currentModel.id).toBe("original");
    expect(runtime.setModelCalls).toHaveLength(0);
  });

  it("retries once, then switches to Gemini and Sonnet, then gives up", async () => {
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    const first = (await handler(turn(message(), "empty-1"), runtime.ctx)) as any;
    expect(first).toMatchObject({ continue: true });
    expect(first.entries).toEqual([
      { type: "context_edit", targetId: "empty-1", replacement: null },
    ]);

    const second = (await handler(turn(message(), "empty-2"), runtime.ctx)) as any;
    expect(second).toMatchObject({ continue: true });
    expect(runtime.currentModel.id).toBe("gemini-3.8-flash-high");

    const third = (await handler(
      turn(message({ model: "gemini-3.8-flash-high" }), "empty-3"),
      runtime.ctx,
    )) as any;
    expect(third).toMatchObject({ continue: true });
    expect(runtime.currentModel.id).toBe("claude-sonnet-5-5");

    const fourth = (await handler(
      turn(message({ model: "claude-sonnet-5-5" }), "empty-4"),
      runtime.ctx,
    )) as any;
    expect(fourth).toBeUndefined();
    expect(runtime.notifications.at(-1)?.level).toBe("warning");
    expect(runtime.setModelCalls.map(({ id }) => id)).toEqual([
      "gemini-3.8-flash-high",
      "claude-sonnet-5-5",
    ]);
  });

  it("skips a missing fallback and uses the next available model", async () => {
    const runtime = setup({ availableFallbacks: ["claude-sonnet-5-5"] });
    const handler = runtime.handlers.get("turn_end")!;

    await handler(turn(message(), "empty-1"), runtime.ctx);
    const result = (await handler(turn(message(), "empty-2"), runtime.ctx)) as any;

    expect(result).toMatchObject({ continue: true });
    expect(runtime.currentModel.id).toBe("claude-sonnet-5-5");
  });

  it("resets the retry sequence after a non-empty response", async () => {
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    await handler(turn(message(), "empty-1"), runtime.ctx);
    await handler(
      turn(message({ content: [{ type: "text", text: "answer" }] }), "answer"),
      runtime.ctx,
    );
    const result = (await handler(turn(message(), "empty-again"), runtime.ctx)) as any;

    expect(result).toMatchObject({ continue: true });
    expect(runtime.currentModel.id).toBe("original");
    expect(runtime.setModelCalls).toHaveLength(0);
  });

  it("restores the original model after the fallback succeeds", async () => {
    const runtime = setup();
    const turnEnd = runtime.handlers.get("turn_end")!;
    const settled = runtime.handlers.get("agent_settled")!;

    await turnEnd(turn(message(), "empty-1"), runtime.ctx);
    await turnEnd(turn(message(), "empty-2"), runtime.ctx);
    await turnEnd(
      turn(message({ model: "gemini-3.8-flash-high", content: [{ type: "text", text: "answer" }] })),
      runtime.ctx,
    );
    await settled({ type: "agent_settled", aborted: false }, runtime.ctx);

    expect(runtime.currentModel.id).toBe("original");
    expect(runtime.setModelCalls.map(({ id }) => id)).toEqual([
      "gemini-3.8-flash-high",
      "original",
    ]);
  });

  it("does not restore when the user changes model after the fallback", async () => {
    const runtime = setup();
    const turnEnd = runtime.handlers.get("turn_end")!;
    const settled = runtime.handlers.get("agent_settled")!;

    await turnEnd(turn(message(), "empty-1"), runtime.ctx);
    await turnEnd(turn(message(), "empty-2"), runtime.ctx);
    runtime.setUserModel({ provider: "cliproxyapi", id: "user-selected" });
    await settled({ type: "agent_settled", aborted: false }, runtime.ctx);

    expect(runtime.setModelCalls.map(({ id }) => id)).toEqual(["gemini-3.8-flash-high"]);
  });

  it("supports forced empty responses for the requested number of stop responses", async () => {
    process.env.PI_EMPTY_RETRY_SIMULATE = "1";
    const runtime = setup();
    const handler = runtime.handlers.get("turn_end")!;

    const result = (await handler(
      turn(message({ content: [{ type: "text", text: "would normally be visible" }] })),
      runtime.ctx,
    )) as any;

    expect(result).toMatchObject({ continue: true });
  });
});

describe("subagent_done final answer guard", () => {
  beforeEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[GUARD];
  });

  const thinking = { type: "thinking", thinking: "I will answer alongside the tool call" };
  const doneCall = { type: "toolCall", id: "done-1", name: "subagent_done", arguments: {} };
  const readCall = { type: "toolCall", id: "read-1", name: "read", arguments: {} };
  const text = (value: string) => ({ type: "text", text: value });

  function assistant(content: unknown[]) {
    return { type: "message_end", message: message({ content: content as never, stopReason: "toolUse" }) };
  }

  function doneEvent() {
    return { type: "tool_call", toolCallId: "done-1", toolName: "subagent_done", input: {} };
  }

  it.each([
    ["text in the same message", { hasText: true, hasToolCalls: true }, undefined, true],
    ["previous plain text answer", { hasText: false, hasToolCalls: true }, { hasText: true, hasToolCalls: false }, true],
    ["previous text that also called tools", { hasText: false, hasToolCalls: true }, { hasText: true, hasToolCalls: true }, false],
    ["no text at all", { hasText: false, hasToolCalls: true }, { hasText: false, hasToolCalls: true }, false],
    ["no history", undefined, undefined, false],
  ])("hasFinalAnswerForSubagentDone: %s", (_name, current, previous, expected) => {
    expect(hasFinalAnswerForSubagentDone(current as never, previous as never)).toBe(expected);
  });

  it("blocks subagent_done when the model only thought about the answer", async () => {
    const runtime = setup();
    await runtime.handlers.get("message_end")!(assistant([thinking, doneCall]), runtime.ctx);

    const result = await runtime.handlers.get("tool_call")!(doneEvent(), runtime.ctx);

    expect(result).toEqual({ block: true, reason: SUBAGENT_DONE_BLOCK_REASON });
  });

  it("allows subagent_done when the final text is in the same message", async () => {
    const runtime = setup();
    await runtime.handlers.get("message_end")!(assistant([thinking, text("1 + 1 = 2"), doneCall]), runtime.ctx);

    expect(await runtime.handlers.get("tool_call")!(doneEvent(), runtime.ctx)).toBeUndefined();
  });

  it("allows subagent_done right after a plain text answer", async () => {
    const runtime = setup();
    const messageEnd = runtime.handlers.get("message_end")!;
    await messageEnd({ type: "message_end", message: message({ content: [text("Result: 2")] as never }) }, runtime.ctx);
    await messageEnd(assistant([doneCall]), runtime.ctx);

    expect(await runtime.handlers.get("tool_call")!(doneEvent(), runtime.ctx)).toBeUndefined();
  });

  it("blocks when the only text was an intermediate note before tool work", async () => {
    const runtime = setup();
    const messageEnd = runtime.handlers.get("message_end")!;
    await messageEnd(assistant([text("Let me check the file"), readCall]), runtime.ctx);
    await messageEnd(assistant([doneCall]), runtime.ctx);

    expect(await runtime.handlers.get("tool_call")!(doneEvent(), runtime.ctx)).toMatchObject({ block: true });
  });

  it("ignores other tools and non-assistant messages", async () => {
    const runtime = setup();
    await runtime.handlers.get("message_end")!(
      { type: "message_end", message: { role: "user", content: "hi", timestamp: 0 } },
      runtime.ctx,
    );

    expect(
      await runtime.handlers.get("tool_call")!({ type: "tool_call", toolCallId: "r", toolName: "read", input: {} }, runtime.ctx),
    ).toBeUndefined();
  });

  it("fails open after the maximum number of consecutive blocks", async () => {
    const runtime = setup();
    const messageEnd = runtime.handlers.get("message_end")!;
    const toolCall = runtime.handlers.get("tool_call")!;

    for (let i = 0; i < MAX_SUBAGENT_DONE_BLOCKS; i++) {
      await messageEnd(assistant([thinking, doneCall]), runtime.ctx);
      expect(await toolCall(doneEvent(), runtime.ctx)).toMatchObject({ block: true });
    }
    await messageEnd(assistant([thinking, doneCall]), runtime.ctx);

    expect(await toolCall(doneEvent(), runtime.ctx)).toBeUndefined();
    expect(runtime.notifications.at(-1)).toMatchObject({ level: "warning" });
  });

  it("resets the block counter after the run settles", async () => {
    const runtime = setup();
    const messageEnd = runtime.handlers.get("message_end")!;
    const toolCall = runtime.handlers.get("tool_call")!;

    for (let i = 0; i < MAX_SUBAGENT_DONE_BLOCKS; i++) {
      await messageEnd(assistant([thinking, doneCall]), runtime.ctx);
      await toolCall(doneEvent(), runtime.ctx);
    }
    await runtime.handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, runtime.ctx);
    await messageEnd(assistant([thinking, doneCall]), runtime.ctx);

    expect(await toolCall(doneEvent(), runtime.ctx)).toMatchObject({ block: true });
  });
});
