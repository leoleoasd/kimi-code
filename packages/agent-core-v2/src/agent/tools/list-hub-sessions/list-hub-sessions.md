List the sessions reachable on the kimi hub this session is attached to: one block per connected agent (machine name, platform, working directory) with the session ids it exposes.

Use it to pick the `session_id` for a SendHubMessage target, or to answer "who else is working on this hub". Sessions marked "(bridged from this machine)" belong to your own connection — you cannot message your own session, and messaging another session of your own machine is rarely what the user wants.
