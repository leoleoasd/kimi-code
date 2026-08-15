---
"@moonshot-ai/kimi-code": patch
---

Fix the built-in self-updater replacing fork-installed binaries with upstream releases; fork builds now keep their own update channel and skip the upstream update preflight.
