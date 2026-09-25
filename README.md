# pi web fetch

A local [Pi](https://pi.dev) extension that adds `fetch_web_md`: a tool for converting a public web page into clean Markdown through [markdown.new](https://markdown.new/).

## Requirements

- Node.js 22.19 or later
- [pnpm](https://pnpm.io/)
- Pi 0.87.1 or a compatible version

Install this repository's development dependencies:

```bash
pnpm install
```

## Load locally

Run Pi with the extension from this directory:

```bash
pi --extension ./fetch-web-md.ts
```

For a persistent personal installation, symlink this repository directory into `~/.pi/agent/extensions/`; Pi loads its `index.ts` entry point. Keep this repository's `node_modules` available because the extension uses `ipaddr.js` for URL validation.

This project is intentionally private and local-only. It does not build or publish an npm package.

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

The tool sends a JSON POST request to `https://markdown.new/` and returns its Markdown content plus structured metadata such as title, conversion method, duration, token estimate, and remaining rate-limit value when supplied by the service.

## Limits and safety

- Requests time out after **30 seconds**, including response-body reading.
- The upstream response is capped at **10 MiB** (both declared and streaming body size) before JSON parsing.
- Model-facing output is capped at Pi's standard **2,000 lines or 50 KiB**. When that cap is reached, the complete permitted Markdown is saved as `page.md` under a newly created temporary directory; the tool result reports its path.
- URLs with credentials, non-HTTP(S) protocols, local/single-label names, and obvious local/private/reserved IP literals are rejected. IPv4-mapped IPv6 literals are also rejected.
- Domain names are **not DNS-resolved locally**. This check cannot prevent a public DNS name from resolving or later rebinding to a private address, and it cannot control markdown.new redirects. markdown.new performs the remote fetch, so use only URLs you trust to disclose to that third party.

markdown.new documents a fair-use limit of 500 requests per IP per day. HTTP 429 errors are returned as actionable tool failures. The external service's availability, URL access rules, and conversion quality are outside this extension's control; respect target-site terms and robots directives.

## Development

```bash
pnpm check
```

`pnpm check` runs TypeScript typechecking and the Vitest suite. Tests mock `fetch`; they do not call markdown.new or any other remote service.

To reload changes in an interactive Pi session, use `/reload`, or start Pi again with the `--extension` command above.
