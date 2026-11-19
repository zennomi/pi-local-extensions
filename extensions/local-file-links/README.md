# local-file-links

Fixes inline Markdown file links in Pi's interactive transcript without changing saved messages. For example, in the project containing `docs/playbook.md`, `[playbook](docs/playbook.md)` becomes a clickable absolute file URL.

Resolution is deliberately root-first, matching Pi fullscreen's opener: try `/docs/playbook.md`, then `<session cwd>/docs/playbook.md`. A single leading slash is accepted too. If neither target exists, leave the link alone. This does not search other projects.

Only inline link destinations in completed user/assistant messages are transformed. Schemed URLs (including existing file URLs), images, reference definitions, code examples and standalone anchors are unchanged. Queries and fragments are preserved; how they open depends on the OS handler. Requires the host's `registerMarkdownTransformer` API. Use `/reload` after enabling it.

On macOS, a normal click in Pi fullscreen checks the file’s default app with Launch Services. If it is Antigravity IDE, Pi sends both the session directory and the file in one CLI request. An existing folder window for that directory is reused; otherwise the IDE opens that folder without replacing a different workspace. This targets the Pi folder, not the last active IDE window or an arbitrary multi-root workspace. Antigravity receives the filesystem path (not a Markdown section anchor). Other applications, directories, and web links keep Pi’s normal behavior. Terminal-native modifier clicks bypass Pi. The hook is local to the TUI instance; it does not install a URL handler or change macOS/IDE defaults.
