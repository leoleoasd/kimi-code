---
'@moonshot-ai/kimi-code': minor
---

Auto-connect the hub on TUI startup: a new `[remote]` section in `~/.kimi-code/tui.toml` (`hub_url`, optional `token` and `name`) makes the TUI run `/remote connect` automatically once a session exists. The connect is one-shot per process — after a refusal or a manual `/remote disconnect` only an explicit `/remote connect` reconnects.
