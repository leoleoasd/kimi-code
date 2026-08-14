---
"@moonshot-ai/kimi-code": minor
---

Add remote-control bridging to a kimi hub: `kimi remote connect <hub-url> --session <id>` exposes one session to the hub web UI, and the `/remote connect` slash command bridges the current session without leaving the TUI — every session you open afterwards in that TUI stays bridged until you disconnect, and two TUIs bridge independently. Run `/remote connect <hub-url> [--token <t>]` inside a session (or set `KIMI_HUB_TOKEN`) to connect.
