---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Mirror engine-side queued prompts (submitted from another surface, e.g. the hub web UI) in the TUI's queue display; stop dropping `prompt.completed`/`prompt.aborted`/`prompt.steered` from the SDK event stream.
