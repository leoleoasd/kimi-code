---
"@moonshot-ai/kimi-code": patch
---

Fix subcommand options colliding with same-named global options (e.g. `kimi export --yes`) being swallowed by the top-level parser before reaching the subcommand.
