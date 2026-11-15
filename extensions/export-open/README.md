# export-open

Adds `/export-open`: export the current session as HTML and immediately open it with the system
default HTML application (normally the default browser). No arguments are needed; any arguments are ignored.

```text
/export-open
```

- Writes to literal `/tmp/pi-session-<session-basename>.html`, not `$TMPDIR` or the working directory.
- Repeating the command for the same session overwrites its previous export.
- Uses the same `AgentSession.exportToHtml()` pipeline as built-in `/export`, including the current
  theme, system prompt, tools, and custom tool renderers. It does not invoke a model.
- Opens via `open` on macOS, `xdg-open` on Linux, or `cmd /c start` on Windows (requires an existing
  `/tmp` directory on that drive). Opening occurs on the machine running Pi, not a remote SSH client.
- If opening fails, the notification includes the saved HTML path so it can be opened manually.
- In-memory sessions and sessions without a saved conversation report the built-in export errors.

## Compatibility

Pi does not expose HTML export through the extension context. The extension wraps the host
`AgentSession.prototype.prompt` once to capture sessions via weak references, then calls the host
export method directly. A global symbol guard prevents wrapper stacking on `/reload`. No private
runner fields are accessed, and normal prompts retain their original arguments and return value.

If a session cannot be captured, the extension warns and loads Pi's internal
`dist/core/export-html/index.js` relative to the **running host package**. This fallback includes
session data, the system prompt, tool metadata, and the named theme, but lacks custom tool
pre-rendering; custom tools use the generic HTML display. The fallback is not guaranteed to look
identical to `/export`. Both the hook and the internal module path may need updating after Pi changes.
An export failure does not trigger the fallback or open an old file.

## Privacy

The export is local; nothing is uploaded. HTML contains the session transcript and may contain
sensitive prompts and tool output. Files remain in `/tmp` until removed by you or the OS; this
extension does not schedule cleanup.

## Development

`createExportOpen({ outputDir, opener, platform })` provides test-only overrides. Tests use temporary
directories, a faux provider, and a mocked opener, so they do not call external models or launch browsers.
