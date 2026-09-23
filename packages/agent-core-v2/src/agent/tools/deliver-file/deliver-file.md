Deliver a file to the user: the file is copied into the session media store and the web UI renders it as a card the user can open in a new tab or download with one click.

Use when the user should receive the file itself — a generated report, chart, archive, log capture, or any artifact they asked to keep — not when the content can simply be written into the reply.

`path` is the file to send (workspace-relative or absolute); `name` optionally overrides the display/download name. Directories and files over 100 MiB are rejected.
