# Inbox

The inbox gathers what an agent session needs from the person, and what the
agent noticed along the way, into one place beside the conversation. The agent
is Claude, in Claude Code.

## Language

### What waits on the person

**Needs you**:
Everything that waits on the person: open questions, and their tasks.
_Avoid_: waiting

**Question**:
Something the agent asked that only the person can answer.
_Avoid_: decide, decision

**Task**:
Something only the person can do, such as signing in.
_Avoid_: do, todo

**Closed item**:
A question or task that is no longer open: answered, done, dismissed, expired,
or closed by the agent.
_Avoid_: decided

**Finding**:
An issue or opportunity the agent noticed outside the current task.
_Avoid_: note

### Surfaces

**Band**:
In Claude Code, the line above the prompt with the Needs you and Findings
counts and [Open inbox]. When the session stops, a second line says why, with
[Resume] after an API error.

**Pane**:
The `/inbox` panel beside the conversation in Claude Code, with its Needs
you, Findings and PRs tabs.

**Card**:
The short summary of where the session stands: its goal, what's done, and
what's happening now. The inbox model writes it, and the agent reads it in
the `inbox:` text beside each prompt. No look draws it.

**New row**:
A row a look lists for the first time since it last recorded its rows. A
look showing an empty tab moves to the tab with the new row.

**Last action**:
What an item or PR in the inbox says after the person presses one of its
actions: a ✓ and the action in the past tense, as in "✓ Discussed · 1m ago".
Explain and Discuss read "Explaining…" or "Discussing…" until the agent
replies. A row handed to the agent that its reply left open reads "Still
open". Each keeps only its latest.

### Looks and hosts

**Look**:
One of the two ways the inbox is drawn: `terminal` in the Claude Code
terminal and `desktop` in the pane of the Claude desktop app's Code sessions.
`Look` in `hooks/view.ts`.
_Avoid_: client, surface

**Host**:
The program that runs the inbox code: Claude Code, which runs the mod and
draws the terminal and desktop looks.

**Shared module**:
A file in `hooks/` that holds rules, not drawing. It imports nothing from the
engine.

**Adapter**:
The code that draws the shared view in one look: `hooks/register.tsx` for the
terminal and desktop looks.

**Difference on purpose**:
A behavior that differs between looks because one look cannot do something,
or because the product decided so. Any other difference is drift.

The engine has two terms of its own. Its `surface` is where Claude Code runs,
and includes `mobile` and `vscode`; `lookOf` in `hooks/register.tsx` maps it to
a look. Its `Client` is a drawn region that takes clicks over its whole shape,
as in `hooks/row-client.tsx`.
