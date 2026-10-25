import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FALLBACK_MODELS = [
  { provider: "cliproxyapi", id: "gemini-3.8-flash-high" },
  { provider: "cliproxyapi", id: "claude-sonnet-5-5" },
] as const;

const EXTENSION_GUARD = Symbol.for("pi-local-extensions/empty-response-retry");
const SIMULATION_ENV = "PI_EMPTY_RETRY_SIMULATE";

type ModelRef = { provider: string; id: string };

type RetryState = {
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

export function isEmptyAssistantMessage(message: AssistantMessage): boolean {
  if (message.role !== "assistant" || message.stopReason !== "stop") return false;
  if (message.content.some((block) => block.type === "toolCall")) return false;
  return !message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
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
    emptyAttempts: 0,
    triedFallbacks: new Set(),
    simulatedResponses: 0,
  };

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    const limit = simulationLimit();
    const simulated = message.role === "assistant" && message.stopReason === "stop" && state.simulatedResponses < limit;
    if (simulated) state.simulatedResponses += 1;

    if (message.role !== "assistant") return;
    if (!simulated && !isEmptyAssistantMessage(message)) {
      resetAttempts(state);
      return;
    }

    const currentModel: ModelRef = {
      provider: message.provider,
      id: message.model,
    };

    if (state.emptyAttempts === 0 && !state.originalModel) {
      state.originalModel = ctx.model;
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
    resetAttempts(state);
  });
}
