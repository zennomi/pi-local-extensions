import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FALLBACK_MODELS = [
  { provider: "cliproxyapi", id: "gemini-3.8-flash-high" },
  { provider: "cliproxyapi", id: "claude-sonnet-5-5" },
] as const;

export const TERMINATED_SUBAGENT_FALLBACK = {
  provider: "cliproxyapi",
  id: "claude-opus-5-5",
} as const;

export const CONTENT_FILTER_FALLBACK = {
  provider: "cliproxyapi",
  id: "gemini-3.8-flash-high",
} as const;

export const SUBAGENT_ENV = "PI_SUBAGENT_ID";
export const SUBAGENT_DONE_TOOL = "subagent_done";
/** Consecutive blocks before failing open, so a model that never writes text cannot loop forever. */
export const MAX_SUBAGENT_DONE_BLOCKS = 2;
export const SUBAGENT_DONE_BLOCK_REASON =
  "subagent_done was blocked: you have not written a visible final answer. " +
  "Thinking/reasoning is NOT returned to the caller — only normal assistant text is. " +
  "Write your final result/summary now as a plain text assistant message, " +
  "then call subagent_done again (if you are still running).";

const EXTENSION_GUARD = Symbol.for("pi-local-extensions/empty-response-retry");
const SIMULATION_ENV = "PI_EMPTY_RETRY_SIMULATE";

type ModelRef = { provider: string; id: string };

export type AssistantSummary = { hasText: boolean; hasToolCalls: boolean };

type RetryState = {
  currentAssistant?: AssistantSummary;
  previousAssistant?: AssistantSummary;
  subagentDoneBlocks: number;
  emptyAttempts: number;
  triedFallbacks: Set<string>;
  originalModel?: Model<any>;
  extensionModel?: ModelRef;
  simulatedResponses: number;
};

function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

function notify(ctx: { hasUI?: boolean; ui: { notify(message: string, level: "info" | "warning" | "error"): void } }, message: string, level: "info" | "warning" | "error") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function simulationLimit(): number {
  const value = Number.parseInt(process.env[SIMULATION_ENV] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isSubagentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[SUBAGENT_ENV]?.trim() ?? "").length > 0;
}

export function isEmptyAssistantMessage(message: AssistantMessage): boolean {
  if (message.role !== "assistant" || message.stopReason !== "stop") return false;
  if (message.content.some((block) => block.type === "toolCall")) return false;
  return !message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

export function summarizeAssistant(message: AssistantMessage): AssistantSummary {
  return {
    hasText: message.content.some((block) => block.type === "text" && block.text.trim().length > 0),
    hasToolCalls: message.content.some((block) => block.type === "toolCall"),
  };
}

/**
 * pi-herdr-subagents returns the last assistant *text* as the subagent's result. Allow
 * `subagent_done` only when that text is the final answer: written in the same message as the
 * call, or in the previous message when that message was a plain text answer (no tool calls).
 */
export function hasFinalAnswerForSubagentDone(
  current: AssistantSummary | undefined,
  previous: AssistantSummary | undefined,
): boolean {
  if (current?.hasText) return true;
  return previous !== undefined && previous.hasText && !previous.hasToolCalls;
}

export function isTerminatedSubagentError(message: AssistantMessage): boolean {
  if (message.role !== "assistant" || message.stopReason !== "error") return false;

  const errorText = [
    message.errorMessage ?? "",
    ...message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
  ].join("\n");
  const hasSessionPath = /\.pi\/(?:agent\/)?sessions\//i.test(errorText);
  const hasTerminationMarker =
    /\bsubagent_done\b[\s\S]*\bterminated\b/i.test(errorText) ||
    /\bterminated\b[\s\S]*\bsubagent_done\b/i.test(errorText);
  const hasSubagentDoneToolCall = message.content.some(
    (block) => block.type === "toolCall" && block.name === "subagent_done",
  );
  const hasTerminatedErrorMessage = /\bterminated\b/i.test(message.errorMessage ?? "");

  return (
    (hasSessionPath && hasTerminationMarker) ||
    (hasSubagentDoneToolCall && hasTerminatedErrorMessage)
  );
}

export function isWebSocketIdleTimeoutError(message: AssistantMessage): boolean {
  if (message.role !== "assistant" || message.stopReason !== "error") return false;

  const diagnosticText = message.diagnostics ? JSON.stringify(message.diagnostics) : "";
  return /\bWebSocket idle timeout after \d+ms\b/i.test(
    `${message.errorMessage ?? ""}\n${diagnosticText}`,
  );
}

export function isContentFilterError(message: AssistantMessage): boolean {
  if (message.role !== "assistant" || message.stopReason !== "error") return false;

  return (
    /\bResponse incomplete:\s*content_filter\b/i.test(message.errorMessage ?? "") ||
    message.rawStopReason === "incomplete.content_filter"
  );
}

function resetAttempts(state: RetryState): void {
  state.emptyAttempts = 0;
  state.triedFallbacks.clear();
}

export default function emptyResponseRetry(pi: ExtensionAPI): void {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  if (globalState[EXTENSION_GUARD]) return;
  globalState[EXTENSION_GUARD] = true;

  const state: RetryState = {
    subagentDoneBlocks: 0,
    emptyAttempts: 0,
    triedFallbacks: new Set(),
    simulatedResponses: 0,
  };

  pi.on("message_end", (event) => {
    const message = event.message as AssistantMessage;
    if (message.role !== "assistant") return;
    state.previousAssistant = state.currentAssistant;
    state.currentAssistant = summarizeAssistant(message);
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== SUBAGENT_DONE_TOOL) return;

    if (hasFinalAnswerForSubagentDone(state.currentAssistant, state.previousAssistant)) {
      state.subagentDoneBlocks = 0;
      return;
    }

    if (state.subagentDoneBlocks >= MAX_SUBAGENT_DONE_BLOCKS) {
      notify(ctx, "subagent_done still has no final text; allowing it", "warning");
      state.subagentDoneBlocks = 0;
      return;
    }

    state.subagentDoneBlocks += 1;
    notify(ctx, "subagent_done without a final text answer; asking the model to write one", "info");
    return { block: true, reason: SUBAGENT_DONE_BLOCK_REASON };
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    const subagent = isSubagentSession();
    const limit = subagent ? simulationLimit() : 0;
    const simulated = message.role === "assistant" && message.stopReason === "stop" && state.simulatedResponses < limit;
    if (simulated) state.simulatedResponses += 1;

    if (message.role !== "assistant") return;
    const terminatedSubagentError = !simulated && isTerminatedSubagentError(message);
    const webSocketIdleTimeoutError = !simulated && isWebSocketIdleTimeoutError(message);
    const currentModel: ModelRef = {
      provider: message.provider,
      id: message.model,
    };
    const opusKey = modelKey(TERMINATED_SUBAGENT_FALLBACK);
    const afterOpus =
      modelKey(currentModel) === opusKey ||
      state.extensionModel !== undefined && modelKey(state.extensionModel) === opusKey;
    const shouldFallbackToOpus = terminatedSubagentError || webSocketIdleTimeoutError;
    const shouldFallbackToGemini = message.stopReason === "error" && afterOpus;
    const emptyRetry = subagent && (simulated || isEmptyAssistantMessage(message));
    if (!emptyRetry && !shouldFallbackToOpus && !shouldFallbackToGemini) {
      resetAttempts(state);
      return;
    }

    if (state.emptyAttempts === 0 && !state.originalModel) {
      state.originalModel = ctx.model;
    }

    if (shouldFallbackToOpus || shouldFallbackToGemini) {
      const fallback = shouldFallbackToGemini
        ? CONTENT_FILTER_FALLBACK
        : TERMINATED_SUBAGENT_FALLBACK;
      const fallbackKey = modelKey(fallback);
      const reason = shouldFallbackToGemini
        ? "Opus error"
        : webSocketIdleTimeoutError
          ? "WebSocket idle timeout"
          : "Terminated subagent error";
      if (fallbackKey !== modelKey(currentModel) && !state.triedFallbacks.has(fallbackKey)) {
        state.triedFallbacks.add(fallbackKey);
        const model = ctx.modelRegistry.find(fallback.provider, fallback.id);
        if (model && await pi.setModel(model)) {
          state.emptyAttempts += 1;
          state.extensionModel = fallback;
          notify(ctx, `${reason}; switching to ${fallbackKey}`, "info");
          return {
            entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }],
            continue: true,
          };
        }
      }

      notify(ctx, `${reason} fallback unavailable; keeping the error`, "warning");
      resetAttempts(state);
      return undefined;
    }

    if (state.emptyAttempts === 0) {
      state.emptyAttempts = 1;
      notify(ctx, `Empty response; retrying ${modelKey(currentModel)}`, "info");
      return {
        entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }],
        continue: true,
      };
    }

    for (const fallback of FALLBACK_MODELS) {
      const fallbackKey = modelKey(fallback);
      if (fallbackKey === modelKey(currentModel) || state.triedFallbacks.has(fallbackKey)) continue;
      state.triedFallbacks.add(fallbackKey);

      const model = ctx.modelRegistry.find(fallback.provider, fallback.id);
      if (!model) continue;

      const switched = await pi.setModel(model);
      if (!switched) continue;

      state.emptyAttempts += 1;
      state.extensionModel = fallback;
      notify(ctx, `Empty response; switching to ${fallbackKey}`, "info");
      return {
        entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }],
        continue: true,
      };
    }

    notify(ctx, "Empty response retry exhausted; keeping the final empty response", "warning");
    resetAttempts(state);
    return undefined;
  });

  pi.on("session_shutdown", () => {
    delete globalState[EXTENSION_GUARD];
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const originalModel = state.originalModel;
    const extensionModel = state.extensionModel;
    const currentModel = ctx.model;

    if (
      originalModel &&
      extensionModel &&
      currentModel &&
      modelKey(currentModel) === modelKey(extensionModel)
    ) {
      await pi.setModel(originalModel);
    }

    state.originalModel = undefined;
    state.extensionModel = undefined;
    state.simulatedResponses = 0;
    state.subagentDoneBlocks = 0;
    resetAttempts(state);
  });
}
