# web-fetch

Adds the `fetch_web_md` tool: converts a public web page into clean Markdown through [markdown.new](https://markdown.new/), with a bounded static local fallback when that service is unavailable.

Entry point: [`index.ts`](./index.ts). Helpers: `local-fetch.ts`, `local-convert.ts`, `url-safety.ts`.

Runtime dependencies (from the repository `package.json`): `ipaddr.js`, `undici`, `jsdom`, `@mozilla/readability`, `turndown`, `turndown-plugin-gfm`.

Load only this extension:

```bash
pi --extension ./extensions/web-fetch/index.ts
```

## Tool

```text
fetch_web_md({
  url: "https://example.com",
  method?: "auto" | "ai" | "browser",
  retain_images?: boolean
})
```

- `url` is a public HTTP(S) URL.
- `method` defaults to `auto`; use `browser` for JavaScript-heavy pages or `ai` to request the Workers AI conversion path.
- `retain_images` defaults to `false`.

The tool sends a JSON POST request to `https://markdown.new/` first and returns its Markdown content plus structured metadata such as title, conversion method, duration, token estimate, and remaining rate-limit value when supplied by the service.

## Local fallback

On an upstream transport/conversion failure (including rate limits), the extension makes a small, static fallback attempt. It does **not** run for invalid URLs, caller cancellation, or an oversized markdown.new response.

The fallback tries, in order:

1. Direct Markdown and `Accept: text/markdown` content negotiation.
2. A same-origin `rel="alternate" type="text/markdown"` representation advertised by HTML or an HTTP `Link` header.
3. A same-origin `/llms.txt` only when it contains an unambiguous link to the exact requested page. An unrelated site index is reported as context and never replaces the requested page.
4. GitHub-specific public sources: repository README, source-file raw link discovered from its page, and raw issue/PR body plus up to 100 comments through the unauthenticated REST API.
5. Static HTML extraction with Mozilla Readability and Turndown/GFM.

Supported GitHub web URLs include repository landing pages, source file pages, issues, pull requests, discussion pages, profiles/organizations, and published GitHub Pages sites. GitHub Discussions use public server-rendered HTML because their complete API requires authentication; replies or paginated content can be missing and are marked as potentially incomplete. Reddit and X/Twitter support, TLS impersonation with `impit`, and a bundled headless browser are deliberately out of scope for this version.

The fallback does not execute JavaScript. If it detects a likely client-rendered shell, it returns any static text it can extract with an **Incomplete static fallback** warning. When Pi has active `browser_*` tools, the warning advises using them to render and inspect the page instead. A requested `method: "browser"` only affects markdown.new; the local fallback remains static.

Fallback details include `fallback`, `primaryError`, `warnings`, and `partial`, as well as the fallback `conversionMethod` and final `sourceUrl`.

## Limits and safety

- markdown.new requests time out after **30 seconds**, including response-body reading. Local requests use a **20-second** per-request timeout, at most **8** requests and **5** redirects for one fallback attempt.
- Every response body is capped at **10 MiB** (both declared and streaming body size) before parsing.
- Direct local requests validate each URL and redirect, restrict to public HTTP(S) destinations, and use a DNS lookup that validates and pins the selected public address for the connection. This reduces DNS-rebinding risk; it cannot make arbitrary third-party content safe or override a proxy's network policy.
- Model-facing output is capped at Pi's standard **2,000 lines or 50 KiB**. When that cap is reached, the complete permitted Markdown is saved as `page.md` under a newly created temporary directory; the tool result reports its path.
- URLs with credentials, non-HTTP(S) protocols, local/single-label names, and obvious local/private/reserved IP literals are rejected. IPv4-mapped IPv6 literals are also rejected.
- markdown.new performs the primary remote fetch, including its redirects, so use only URLs you trust to disclose to that third party. Its availability, URL access rules, and conversion quality are outside this extension's control.
- GitHub's unauthenticated REST API is rate limited (typically 60 requests/hour/IP); its API route may fall back to public HTML. Respect target-site terms, robots directives, and rate limits.

markdown.new documents a fair-use limit of 500 requests per IP per day. A 429 normally triggers the local fallback; if that cannot obtain useful static content, the tool returns both failure reasons.
