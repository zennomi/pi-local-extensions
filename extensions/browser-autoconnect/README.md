# browser-autoconnect

Automatically runs `/browser-setup` at interactive startup when
[`pi-browser-harness`](https://www.npmjs.com/package/pi-browser-harness) is enabled and the browser
is disconnected.

Entry point: [`index.ts`](./index.ts). No runtime dependencies.

Behavior:

- Runs only for the initial `startup` session with a UI.
- Non-interactive sessions and later `/new`, `/resume`, `/fork`, or `/reload` sessions are left unchanged.
- Does nothing if `pi-browser-harness` is not loaded or `/browser-setup` is not registered.
- Setup errors are reported by the harness command itself; dispatch errors show a warning notification.

Load only this extension:

```bash
pi --extension ./extensions/browser-autoconnect/index.ts
```
