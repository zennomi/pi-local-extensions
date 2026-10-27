import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter } from "node:path";
import { execFile } from "node:child_process";
import type { Dispatcher } from "undici";
import { assessContent } from "./content-quality.js";
import {
  ConverterError,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  errorMessage,
  rotateProxyUrl,
  withProxyRetry,
} from "./converter-utils.js";

const LIGHTPANDA_TIMEOUT_MS = 30_000;
const LIGHTPANDA_WAIT_MS = 10_000;
const LIGHTPANDA_TERMINATE_MS = 25_000;
const LIGHTPANDA_HTTP_TIMEOUT_MS = 15_000;
const LIGHTPANDA_MAX_BUFFER = MAX_RESPONSE_BYTES + 2 * 1024 * 1024;

export interface LightpandaResult {
  markdown: string;
  title?: string;
  sourceUrl: string;
  conversionMethod: string;
  warnings: string[];
  targetStatus?: number;
  partial?: boolean;
  usedProxy?: boolean;
}

export interface LightpandaRunOptions {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface LightpandaRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type LightpandaRunner = (
  binary: string,
  args: string[],
  options: LightpandaRunOptions,
) => Promise<LightpandaRunResult>;

export class LightpandaUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LightpandaUnavailable";
  }
}

let testRunner: LightpandaRunner | undefined;

export function setLightpandaRunnerForTesting(runner?: LightpandaRunner): void {
  testRunner = runner;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveLightpandaBinary(): Promise<string | undefined> {
  if (process.env.PI_WEB_FETCH_LIGHTPANDA === "0") return undefined;

  const configured = process.env.LIGHTPANDA_PATH?.trim();
  if (configured) return (await executable(configured)) ? configured : undefined;

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = `${directory}/lightpanda`;
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

function redact(value: string): string {
  const proxy = rotateProxyUrl();
  return proxy ? value.split(proxy).join("[configured proxy]") : value;
}

function defaultRunner(
  binary: string,
  args: string[],
  options: LightpandaRunOptions,
): Promise<LightpandaRunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      binary,
      args,
      {
        env: options.env,
        maxBuffer: LIGHTPANDA_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new Error("Lightpanda response exceeds the 10.0MB limit."));
          return;
        }
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(
      () => finishWithError(new Error(`Lightpanda request timed out after ${options.timeoutMs / 1_000}s.`)),
      options.timeoutMs,
    );
    const abort = () => finishWithError(new Error("Lightpanda request was aborted."));
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

function argsFor(url: string, retainImages: boolean, proxyUrl?: string): string[] {
  return [
    "fetch",
    "--json",
    "--dump",
    "markdown",
    "--strip-mode",
    "clutter",
    ...(retainImages ? [] : ["--strip-mode", "ui"]),
    "--block-private-networks",
    "--log-level",
    "err",
    "--wait-until",
    "networkalmostidle",
    "--wait-ms",
    String(LIGHTPANDA_WAIT_MS),
    "--terminate-ms",
    String(LIGHTPANDA_TERMINATE_MS),
    "--http-timeout",
    String(LIGHTPANDA_HTTP_TIMEOUT_MS),
    "--dump-max-bytes",
    String(MAX_RESPONSE_BYTES),
    ...(proxyUrl ? ["--http-proxy", proxyUrl] : []),
    url,
  ];
}

export function buildLightpandaArgs(url: string, retainImages: boolean, proxyUrl?: string): string[] {
  return argsFor(url, retainImages, proxyUrl);
}

function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["js_challenge", "jsc_token", "jsc_orig_r", "solution"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function cleanMarkdown(markdown: string): string {
  return markdown.replace(/https?:\/\/[^\s<>)]+/gi, (value) => cleanUrl(value));
}

function titleFromMarkdown(markdown: string): string | undefined {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || undefined;
}

function parseOutput(
  url: string,
  raw: LightpandaRunResult,
): LightpandaResult {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.stdout.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    throw new ConverterError(
      `Lightpanda returned invalid JSON${raw.stderr.trim() ? `: ${redact(raw.stderr.trim())}` : "."}`,
      "lightpanda",
      0,
      true,
      { cause: error },
    );
  }

  const errorText = typeof payload.error === "string" ? payload.error : undefined;
  if (raw.exitCode !== 0 || errorText) {
    const reason = errorText ?? `process exited with code ${raw.exitCode}`;
    throw new ConverterError(
      `Lightpanda fetch failed: ${redact(reason)}${raw.stderr.trim() ? ` (${redact(raw.stderr.trim())})` : ""}`,
      "lightpanda",
      typeof payload.http_status === "number" ? payload.http_status : 0,
      true,
    );
  }

  if (typeof payload.content !== "string" || payload.content.length === 0) {
    throw new ConverterError("Lightpanda returned no Markdown content.", "lightpanda", 0, true);
  }

  const targetStatus = typeof payload.http_status === "number" ? payload.http_status : undefined;
  const botChallenge = Boolean(payload.bot_challenge);
  const warnings = botChallenge ? ["Lightpanda reported a bot challenge."] : [];
  const markdown = cleanMarkdown(payload.content);
  return {
    markdown,
    title: titleFromMarkdown(markdown),
    sourceUrl: typeof payload.url === "string" ? cleanUrl(payload.url) : cleanUrl(url),
    conversionMethod: "Lightpanda browser dump",
    warnings,
    targetStatus,
    partial: botChallenge,
  };
}

async function runOnce(
  binary: string,
  url: string,
  retainImages: boolean,
  signal: AbortSignal | undefined,
  proxyUrl?: string,
): Promise<LightpandaResult> {
  const runner = testRunner ?? defaultRunner;
  let raw: LightpandaRunResult;
  try {
    raw = await runner(binary, argsFor(url, retainImages, proxyUrl), {
      env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      signal,
      timeoutMs: LIGHTPANDA_TIMEOUT_MS,
    });
  } catch (error) {
    if (signal?.aborted || errorMessage(error).includes("timed out")) throw error;
    throw new ConverterError(`Lightpanda process failed: ${redact(errorMessage(error))}`, "lightpanda", 0, true, {
      cause: error,
    });
  }
  return parseOutput(url, raw);
}

export async function fetchLightpanda(
  url: string,
  retainImages: boolean,
  signal?: AbortSignal,
): Promise<LightpandaResult> {
  const binary = await resolveLightpandaBinary();
  if (!binary) {
    if (process.env.PI_WEB_FETCH_LIGHTPANDA === "0") {
      throw new LightpandaUnavailable("Lightpanda is disabled by PI_WEB_FETCH_LIGHTPANDA=0.");
    }
    throw new LightpandaUnavailable("Lightpanda is unavailable; set LIGHTPANDA_PATH or add lightpanda to PATH.");
  }

  const { value: direct, usedProxy: errorUsedProxy } = await withProxyRetry(
    "lightpanda",
    (_dispatcher: Dispatcher | undefined, proxyUrl?: string) => runOnce(binary, url, retainImages, signal, proxyUrl),
    signal,
  );
  if (errorUsedProxy) return { ...direct, usedProxy: true };

  const quality = assessContent(direct.markdown, {
    partial: direct.partial,
    targetStatus: direct.targetStatus,
  });
  const proxyUrl = rotateProxyUrl();
  if (!proxyUrl || (!quality.thin && !quality.blocked)) return direct;

  try {
    const proxied = await runOnce(binary, url, retainImages, signal, proxyUrl);
    return { ...proxied, usedProxy: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...direct,
      warnings: [
        ...direct.warnings,
        `Lightpanda proxy retry failed: ${redact(errorMessage(error))}`,
      ],
    };
  }
}
