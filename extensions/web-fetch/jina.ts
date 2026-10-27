import type { Dispatcher } from "undici";
import {
  ConverterError,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  errorMessage,
  hasRateLimitSignal,
  readResponseText,
  withProxyRetry,
} from "./converter-utils.js";

const JINA_URL = "https://r.jina.ai/";

export interface JinaResult {
  markdown: string;
  title?: string;
  sourceUrl: string;
  conversionMethod: string;
  warnings: string[];
  targetStatus?: number;
  rateLimitRemaining?: string;
  usedProxy?: boolean;
}

interface JinaData {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  warning?: unknown;
  httpStatus?: unknown;
}

interface JinaResponse {
  code?: unknown;
  status?: unknown;
  data?: unknown;
  error?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseSizeError(): Error {
  return new Error("jina response exceeds the 10.0MB limit.");
}

function payloadData(payload: JinaResponse): JinaData | undefined {
  return isRecord(payload.data) ? payload.data : undefined;
}

function failure(response: Response, payload?: JinaResponse): ConverterError {
  const data = payloadData(payload ?? {});
  const reason =
    (typeof payload?.error === "string" && payload.error) ||
    (typeof payload?.message === "string" && payload.message) ||
    (typeof data?.warning === "string" && data.warning) ||
    response.statusText ||
    "Request failed.";
  const status = response.status || (typeof payload?.code === "number" ? payload.code : 0);
  const remaining =
    response.headers.get("x-ratelimit-remaining") ?? response.headers.get("x-rate-limit-remaining");
  const retryViaProxy =
    response.status === 429 ||
    response.status === 403 ||
    remaining === "0" ||
    hasRateLimitSignal(reason);
  return new ConverterError(
    `Jina conversion failed (${status}): ${reason}`,
    "jina",
    status,
    retryViaProxy,
  );
}

async function requestJina(
  url: string,
  retainImages: boolean,
  signal: AbortSignal | undefined,
  dispatcher?: Dispatcher,
): Promise<{ result: JinaResult; response: Response }> {
  if (signal?.aborted) throw new Error("Jina request was aborted.", { cause: signal.reason });

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const request: RequestInit & { dispatcher?: Dispatcher } = {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(retainImages ? {} : { "X-Retain-Images": "none" }),
        ...(process.env.JINA_API_KEY?.trim()
          ? { Authorization: `Bearer ${process.env.JINA_API_KEY.trim()}` }
          : {}),
      },
      signal: controller.signal,
    };
    if (dispatcher) request.dispatcher = dispatcher;

    const response = await fetch(`${JINA_URL}${url}`, request);
    const raw = await readResponseText(response, MAX_RESPONSE_BYTES, responseSizeError);
    let payload: JinaResponse | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      payload = isRecord(parsed) ? parsed : undefined;
    } catch (error) {
      throw new ConverterError(
        `Jina returned invalid JSON (${response.status} ${response.statusText}).`,
        "jina",
        response.status,
        true,
        { cause: error },
      );
    }

    if (!response.ok || (typeof payload?.code === "number" && payload.code >= 400 && !payloadData(payload)?.content)) {
      throw failure(response, payload);
    }

    const data = payloadData(payload ?? {});
    if (!data || typeof data.content !== "string" || data.content.length === 0) {
      throw new ConverterError("Jina returned no Markdown content.", "jina", response.status, true);
    }

    const targetStatus = typeof data.httpStatus === "number" ? data.httpStatus : undefined;
    const warnings = typeof data.warning === "string" && data.warning ? [data.warning] : [];
    return {
      response,
      result: {
        markdown: data.content,
        title: typeof data.title === "string" && data.title ? data.title : undefined,
        sourceUrl: typeof data.url === "string" ? data.url : url,
        conversionMethod: "Jina Reader",
        warnings,
        targetStatus,
        rateLimitRemaining:
          response.headers.get("x-ratelimit-remaining") ??
          response.headers.get("x-rate-limit-remaining") ??
          undefined,
      },
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(`Jina request timed out after ${TIMEOUT_MS / 1_000}s.`, { cause: error });
    }
    if (signal?.aborted) {
      throw new Error("Jina request was aborted.", { cause: error });
    }
    if (errorMessage(error).includes("response exceeds the")) throw error;
    if (error instanceof ConverterError) throw error;
    throw new ConverterError(`Jina request failed: ${errorMessage(error)}`, "jina", 0, true, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

export async function fetchJina(
  url: string,
  retainImages: boolean,
  signal?: AbortSignal,
): Promise<JinaResult> {
  const { value, usedProxy } = await withProxyRetry(
    "jina",
    (dispatcher) => requestJina(url, retainImages, signal, dispatcher),
    signal,
  );
  return { ...value.result, usedProxy };
}
