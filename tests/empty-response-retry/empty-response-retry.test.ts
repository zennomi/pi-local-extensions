import { beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import emptyResponseRetry, {
  CONTENT_FILTER_FALLBACK,
  FALLBACK_MODELS,
  isContentFilterError,
  isEmptyAssistantMessage,
  isTerminatedSubagentError,
  isWebSocketIdleTimeoutError,
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
  beforeEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[GUARD];
    delete process.env.PI_EMPTY_RETRY_SIMULATE;
  });

  it("switches to Opus for a terminated subagent session error", async () => {
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

  it("switches to Opus for a WebSocket idle timeout", async () => {
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

  it("switches from Opus to Gemini for any subsequent error", async () => {
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
