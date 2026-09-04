# Security

Report a vulnerability privately, never in a public issue, through the advisory form:

https://github.com/vitaliyhayda/claude-transplant/security/advisories/new

Expect a reply within a week.

Local moves make no network calls. Remote Control reconciliation, enabled by `--cloud` and by the menubar, reads Claude Desktop's cookie database and its Safe Storage key from macOS Keychain. Cookies are decrypted only in memory, sent only to `https://claude.ai`, and never printed or persisted by claude-transplant. This path reads private session metadata and history, then archives or restores a source Remote Control row only after local verification. It fails closed on authentication, organization, status, history, or response-shape changes.

A rescued remote branch can contain the original messages, tool results, images, and documents. It is written only into the same local Claude transcript pool and Desktop record store already used by Claude Code. Server-owned artifacts, comments, versions, and share links are neither copied nor recreated.
