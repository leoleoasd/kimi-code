Send a plain-text message to the agent running ANOTHER session on the same kimi hub (possibly on another machine). The message lands in that session as a user-role message: steered into the running turn mid-flight if the agent is busy (it answers at its next step, then continues its own work — previously queued prompts stay in line), starting a new turn if it is idle.

A message is text only — no files, diffs, or conversation history travel with it. The receiving agent (and its user) sees it marked as coming from your session, and it can reply to your session the same way.

Do not introduce yourself inside the message body: the envelope header already identifies you to the recipient — your agent name and session id, plus your session's title when one is set.

Find the target's `session_id` with ListHubSessions first. Good uses: hand off a finding or a breaking change, coordinate parallel work trees, request status from long-running work. Send at most one message per reason to act — never trade rapid back-and-forth messages with another agent.
