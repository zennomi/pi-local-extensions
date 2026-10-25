# browser-autoconnect

At interactive startup, checks whether browser remote debugging is allowed when
[`pi-browser-harness`](https://www.npmjs.com/package/pi-browser-harness) is enabled. It does not run
`/browser-setup` or open any tab/window.

Entry point: [`index.ts`](./index.ts). No runtime dependencies.

Behavior:

- Check: reads `DevToolsActivePort` from Edge/Chrome/Chromium/Brave user-data dirs (Edge first,
  `CHROME_USER_DATA_DIR` overrides) and completes a DevTools WebSocket handshake only once per
  browser process. The DevTools browser UUID is persisted in `~/.pi/agent/browser-autoconnect.json`,
  so a new pi reuses the approval without opening another connection. A TCP listener alone is not
  enough: the browser opens it before the **Allow remote debugging?** approval is accepted.
- Enabled: info notification with browser and port, only after the handshake succeeds. Not enabled:
  warning with the `edge://inspect/#remote-debugging` hint.
- Runs only for the initial `startup` session with a UI.
- Non-interactive sessions and later `/new`, `/resume`, `/fork`, or `/reload` sessions are left unchanged.
- Only the first probe for a browser process opens a raw WebSocket handshake; it sends no CDP commands or
  tabs and may be held until you click **Allow**. Later pi sessions use the persisted browser UUID and
  do not open another debugging connection.
- Does nothing if `pi-browser-harness` is not loaded.

Load only this extension:

```bash
pi --extension ./extensions/browser-autoconnect/index.ts
```
