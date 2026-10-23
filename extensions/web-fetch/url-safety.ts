import * as ipaddr from "ipaddr.js";

export const MAX_URL_LENGTH = 8_192;
export const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

export function isPublicIpAddress(hostname: string): boolean {
  if (!ipaddr.isValid(hostname)) return false;
  return ipaddr.process(hostname).range() === "unicast";
}

export function validateHostname(hostname: string): void {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
  const ipLiteral = normalizedHostname.replace(/^\[|\]$/g, "");

  if (ipaddr.isValid(ipLiteral)) {
    if (!isPublicIpAddress(ipLiteral)) {
      throw new Error("url must not target a private, local, or reserved IP address.");
    }
    return;
  }

  if (
    normalizedHostname === "localhost" ||
    LOCAL_HOST_SUFFIXES.some((suffix) => normalizedHostname.endsWith(suffix)) ||
    !normalizedHostname.includes(".")
  ) {
    throw new Error("url must include a public hostname.");
  }
}

/** Validates a public HTTP(S) URL before it can be passed to a remote fetcher. */
export function validateUrl(value: string): string {
  if (value.length > MAX_URL_LENGTH) {
    throw new Error(`URL exceeds the ${MAX_URL_LENGTH}-character limit.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must be a valid absolute http(s) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use the http or https protocol.");
  }
  if (!parsed.hostname) {
    throw new Error("url must include a hostname.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("url must not contain credentials.");
  }

  validateHostname(parsed.hostname);
  return parsed.toString();
}
