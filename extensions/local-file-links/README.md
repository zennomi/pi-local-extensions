# local-file-links

Fixes inline Markdown file links in Pi's interactive transcript without changing saved messages. For example, in the project containing `docs/playbook.md`, `[playbook](docs/playbook.md)` becomes a clickable absolute file URL.

Resolution is deliberately root-first, matching Pi fullscreen's opener: try `/docs/playbook.md`, then `<session cwd>/docs/playbook.md`. A single leading slash is accepted too. If neither target exists, leave the link alone. This does not search other projects.

Only inline link destinations in completed user/assistant messages are transformed. Schemed URLs (including existing file URLs), images, reference definitions, code examples and standalone anchors are unchanged. Queries and fragments are preserved; how they open depends on the OS handler. Requires the host's `registerMarkdownTransformer` API. Use `/reload` after enabling it.
