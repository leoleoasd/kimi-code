Send one message into a RUNNING subagent's active turn. The text lands in the subagent's conversation as a user-role message at its next step boundary — it reads the message mid-work and adjusts (new constraints, corrections, extra context, updated stop conditions) without losing anything it already did. This is the mid-flight alternative to TaskStop + re-spawn.

Use when a subagent you spawned is still running and needs a course correction. Arguments:

- agent_id: the subagent's agent_id from the Agent tool result (`agent-…` — NOT a task_id and NOT a notification's source_id).
- message: plain text, written to the subagent directly ("skip the lint pass and go straight to the failing test").

Routing the errors:

- "not running" → the subagent already finished. Do NOT retry SteerAgent: continue it with `Agent(resume="<agent_id>", prompt="...", description="...")`, which starts a fresh turn on it with full prior context.
- "does not exist" → wrong id; take agent_id from the Agent tool's result block.
- Foreground subagents cannot be steered — your own turn is blocked in that Agent call until they finish.

The subagent cannot message you back mid-turn. Track it via its completion notification, or peek at its live output with TaskOutput.