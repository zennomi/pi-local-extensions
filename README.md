# pi local extensions

A private collection of [Pi](https://pi.dev) extensions that I use locally. Each extension lives in its
own directory under `extensions/` and has its own entry point, so unrelated features stay
independent and can be loaded or disabled separately.

| Extension | Entry point | Purpose |
|---|---|---|
| [web-fetch](./extensions/web-fetch/README.md) | `extensions/web-fetch/index.ts` | `fetch_web_md` tool: web page → Markdown via markdown.new with a static local fallback |
| [browser-autoconnect](./extensions/browser-autoconnect/README.md) | `extensions/browser-autoconnect/index.ts` | Runs `/browser-setup` at interactive startup when `pi-browser-harness` is enabled |

## Layout

```text
extensions/
  <name>/
    index.ts      # extension entry point (default export: (pi: ExtensionAPI) => void)
    README.md     # extension-specific docs
    *.ts          # private helpers for that extension only
tests/
  <name>/*.test.ts
types.d.ts        # shared ambient type declarations
package.json      # shared dependencies + "pi.extensions" manifest
```

Extensions should not import from each other. Shared code, if ever needed, should go in a separate
`shared/` directory instead of reaching into another extension's folder.

## Requirements

- Node.js 22.19 or later
- [pnpm](https://pnpm.io/)
- Pi 0.87.1 or a compatible version

```bash
pnpm install
```

Keep this repository's `node_modules` available: Pi loads the extensions from source and resolves
their runtime dependencies from here.

## Install

Either symlink the repository into Pi's extensions directory:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/pi-local-extensions
```

or register it as a local package (this also lets you enable/disable individual extensions with
`pi config` or package filters in `settings.json`):

```bash
pi install ./path/to/this/repo
```

In both cases Pi reads the `pi.extensions` list in `package.json`. To try one extension for a single
run, pass its entry point directly, e.g. `pi --extension ./extensions/web-fetch/index.ts`.

This project is intentionally private and local-only. It does not build or publish an npm package.

## Add a new extension

1. Create `extensions/<name>/index.ts` with a default-exported `(pi: ExtensionAPI) => void` function.
2. Add `./extensions/<name>/index.ts` to `pi.extensions` in `package.json` (list entries explicitly;
   the extensions-directory symlink loader does not expand globs).
3. Add runtime dependencies to `package.json` `dependencies`; keep Pi host packages in `peerDependencies`.
4. Put tests in `tests/<name>/` and document the extension in `extensions/<name>/README.md`.

## Development

```bash
pnpm check
```

`pnpm check` runs TypeScript typechecking and the Vitest suite. Tests mock `fetch`; they do not call
markdown.new or any other remote service.

To reload changes in an interactive Pi session, use `/reload`.
