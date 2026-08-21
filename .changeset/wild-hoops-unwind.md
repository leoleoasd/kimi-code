---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-code-sdk': minor
---

Close TUI approval/question dialogs when the prompt is resolved through another surface (hub web REST answer, dismiss): the v2 session wiring now carries the kernel interaction id through to clients so panels can be matched and unwound. Hub web: question cards stage answers per question and submit the whole request with one button (multi-question prompts can no longer swallow sibling questions), and the Agent tool frame nests the live subagent thinking/speaking stream inside the frame with the prompt rendered as markdown instead of duplicated JSON.
