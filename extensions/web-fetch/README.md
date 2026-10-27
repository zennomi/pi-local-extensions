# web-fetch

Adds the `fetch_web_md` tool: converts a public web page to Markdown through remote converters, a bounded static fallback, and Lightpanda for JavaScript-rendered pages.

Entry point: [`index.ts`](./index.ts). Helpers: `content-quality.ts`, `converter-utils.ts`, `jina.ts`, `lightpanda.ts`, `local-fetch.ts`, `local-convert.ts`, `url-safety.ts`.

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
- `method` defaults to `auto`; `ai` is passed to markdown.new. `browser` makes the fallback order prefer Lightpanda after markdown.new.
- `retain_images` defaults to `false`.

## Provider chain

The tool tries providers in this order and stops at the first result with enough meaningful content:

- `auto` / `ai`: **markdown.new → Jina → static local fallback → Lightpanda**
- `browser`: **markdown.new → Lightpanda → Jina → static local fallback**

Thin results (less than roughly 400 meaningful characters), client-rendered shells, and common block/challenge pages are not accepted as final content. If every available provider is thin or blocked, the best candidate is returned with an **Incomplete fetch** warning. `details.attempts` records each provider's status, quality, errors, and proxy usage.

### markdown.new

The primary request is a JSON POST to `https://markdown.new/`. When it receives a rate limit, converter-side HTTP 403, or a retryable network error, it retries once through `$ROTATE_PROXY_URL` when configured. Timeouts, caller cancellation, oversized responses, and target-site errors reported by Jina are not retried through the proxy.

### Jina

Jina is called as `GET https://r.jina.ai/<target-url>` with `Accept: application/json`. Set `JINA_API_KEY` to send `Authorization: Bearer ...`; without it, the public endpoint is used. `X-Retain-Images: none` is sent when `retain_images` is false.

A Jina response whose `data.httpStatus` is 400 or above is retained as a blocked candidate and is not proxy-retried: it means Jina reached the target and the target rejected the request. Jina converter rate limits and converter-side failures can retry through `$ROTATE_PROXY_URL`.

### Static local fallback

The local fallback is SSRF-aware and does not execute JavaScript. It supports direct Markdown, same-origin alternate Markdown, `llms.txt`, GitHub public API/raw sources, Mozilla Readability, and Turndown/GFM. Direct local requests remain unproxied and use DNS validation/pinning.

### Lightpanda

When remote/static content is thin, blocked, or unavailable, the extension can run Lightpanda's browser dump command:

```bash
lightpanda fetch --json --dump markdown --strip-mode clutter \
  --block-private-networks --wait-until networkalmostidle --wait-ms 10000 URL
```

The executable is resolved from `$LIGHTPANDA_PATH`, or from `lightpanda` on `$PATH`. The extension never auto-installs or downloads it. Set `PI_WEB_FETCH_LIGHTPANDA=0` to disable this provider. Lightpanda uses `LIGHTPANDA_DISABLE_TELEMETRY=true`, a 30-second process deadline, a 10 MiB dump cap, and `--block-private-networks`. It retries a thin/blocked direct dump once through `$ROTATE_PROXY_URL` when configured.

Install Lightpanda separately according to its [official documentation](https://github.com/lightpanda-io/browser). Its `--http-proxy` option is passed only to the child process; proxy credentials are never included in tool output or error messages.

## Configuration

```bash
export ROTATE_PROXY_URL='http://user:password@proxy.example:8080'
export JINA_API_KEY='...'
export LIGHTPANDA_PATH='/path/to/lightpanda'
# Optional: disable the browser fallback
export PI_WEB_FETCH_LIGHTPANDA=0
```

## Limits and safety

- Remote converter requests and response-body reads time out after **30 seconds**. Lightpanda has a 30-second process deadline; its page wait is 10 seconds and HTTP transfer timeout is 15 seconds.
- Local fallback requests use a **20-second** timeout, at most **8** requests and **5** redirects per operation.
- Every remote/local/browser dump response is capped at **10 MiB** before parsing; model-facing output is capped at Pi's standard **2,000 lines or 50 KiB**. A complete truncated result is saved to a temporary `page.md` file.
- The requested URL is validated as public HTTP(S) before any provider runs. Local requests validate redirects and pin public DNS results. Lightpanda additionally uses `--block-private-networks`, but browser navigation and third-party page JavaScript still run in a separate child process and should be treated as untrusted page content.
- The URL may be disclosed to markdown.new and Jina, two independent third parties. Their availability, URL access rules, conversion quality, and rate limits are outside this extension's control. `$ROTATE_PROXY_URL` is treated as an HTTP(S) proxy URL and is never returned in output.
- GitHub's unauthenticated API is rate limited (typically 60 requests/hour/IP). Respect target-site terms, robots directives, and rate limits.

## Details

Successful results include `provider` (`markdown.new`, `jina`, `local`, or `lightpanda`), final `sourceUrl`, conversion metadata, and `attempts`. Fallback/incomplete results also include `fallback`, `primaryError`, `warnings`, and `partial` where applicable.
