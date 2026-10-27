import { ProxyAgent, type Dispatcher } from "undici";

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const TIMEOUT_MS = 30_000;

export class ConverterError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
    readonly retryViaProxy: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConverterError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasRateLimitSignal(value: string | undefined): boolean {
  return value !== undefined && /rate[ -]?limit|too many requests|throttl|quota|request limit/i.test(value);
}

export function rotateProxyUrl(): string | undefined {
  const value = process.env.ROTATE_PROXY_URL?.trim();
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  responseSizeError: () => Error,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      throw responseSizeError();
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseSizeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function withProxyRetry<T>(
  provider: string,
  attempt: (dispatcher?: Dispatcher, proxyUrl?: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ value: T; usedProxy?: boolean }> {
  try {
    return { value: await attempt() };
  } catch (primaryError) {
    if (!(primaryError instanceof ConverterError) || !primaryError.retryViaProxy || signal?.aborted) {
      throw primaryError;
    }

    const proxyUrl = rotateProxyUrl();
    if (!proxyUrl) throw primaryError;

    let proxy: ProxyAgent;
    try {
      proxy = new ProxyAgent(proxyUrl);
    } catch (proxyError) {
      throw new Error(
        `${errorMessage(primaryError)} Proxy fallback is unavailable because ROTATE_PROXY_URL is invalid.`,
        { cause: proxyError },
      );
    }

    try {
      const value = await attempt(proxy, proxyUrl);
      return { value, usedProxy: true };
    } catch (proxyError) {
      if (signal?.aborted) throw proxyError;
      throw new Error(
        `${errorMessage(primaryError)} Proxy retry via ROTATE_PROXY_URL failed: ${errorMessage(proxyError)}`,
        { cause: proxyError },
      );
    } finally {
      await proxy.close().catch(() => undefined);
    }
  }
}
