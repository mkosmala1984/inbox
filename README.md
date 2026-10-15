# inbox

The inbox gathers what waits on you in an agent session into one organized
place beside the conversation: the agent's questions, tasks only you can do,
issues and ideas it noticed, and your PRs. The agent is Claude. The inbox
runs in two places:

- **Claude Code in the terminal**, as a mod. Type `/inbox`.
- **Code sessions in the Claude desktop app**, as the same mod, in a pane
  beside the conversation.

Each place draws the inbox in its host app's own style. The rules are the
same in both.



https://github.com/user-attachments/assets/a493119c-4d8b-46e0-a18a-bd0ecf041b6b



## Install

### Claude Code

In a Claude Code session in the terminal, type:

```
/plugin install inbox --marketplace petekp/inbox
```

Answer `y` to add the marketplace, then choose a scope. It starts working in
that session. A user-scope install also covers Code sessions in the Claude
desktop app on this machine.

To install from the desktop app instead, open a Code session and choose
+ > Plugins > Add plugin, then Manage plugins. `/plugin` does not run there.
The inbox does not reach the app's cloud sessions.

To update, run these, then `/reload-plugins` in any session that's already
open:

```sh
claude plugin marketplace update inbox
claude plugin update inbox
```

- It makes one Sonnet call after each of Claude's replies. See [Cost](#cost).
- It was built and tested with Claude Code 2.1.300.

The PRs tab needs the GitHub CLI, `gh`, signed in.

## Using it

Type `/inbox` in Claude Code. The inbox has three tabs:

- **Needs you**: questions the agent asked you, and tasks only you can do.
- **Findings**: bugs, risks and ideas the agent noticed outside the task it's
  working on.
- **PRs**: pull requests from this session and your current branch, what's
  blocking each one, and review comments waiting on you.

Each item shows what you can do with it. Press an answer's button and it goes
to the agent as your message. You can also have the agent fix a finding, mark
a task done, or dismiss anything you don't need.

When the tab you're on is empty and something new arrives on another tab, the
inbox switches to it.

### In each app

- **Terminal:** each action shows the letter that runs it. `1`, `2` and `3`
  switch tabs, and `j` and `k` move up and down. ctrl+x tab moves focus from
  the prompt to the line above it, then to the panel, then back to the prompt.
- **Claude desktop app:** you click. `/inbox` sent as the first message of a
  new session is not recognized as a command. Send it after the first
  message.

In Claude Code, a line above your prompt counts what needs you and the
findings waiting, with a button that opens the panel. When Claude stops on an
error, the stop shows on a second line.

To see every part with sample items in Claude Code, run `/inbox demo`. Presses
on them change only the samples and send nothing. Press Hide demo, or run the
command again, to go back to your own items. `/inbox demo recording` shows the
same samples without the notices that mark them, for recording a video. Run
`/inbox demo` to end it.

## Cost

In Claude Code, the inbox adds two things:

| What the inbox adds | Tokens | Cost at API prices |
|---|---|---|
| A Sonnet call after each of Claude's replies, to update the inbox | 3–4k in, about 2k of it cached. 100–250 out. | About 0.5¢ per reply, or 1¢ after 5 idle minutes |
| Its instructions and tools, sent with every request Claude makes | About 1,350, cached | Under 0.1¢ per request |

In one long Opus session, this came to about 1% of the total cost. A shorter
or cheaper session pays a larger share. On a Claude plan, these count toward
your usage limits.

## What it runs, sends and changes

**What leaves your machine.** Three things, and nothing else:

- After each of Claude's replies, the inbox sends one Sonnet request to
  Anthropic through Claude Code's own model connection. It holds your last
  prompt, Claude's reply, the inbox's open items, and a line for each tool
  Claude ran. A tool line reads like `ran: npm test` or
  `edited src/app.ts`. [Cost](#cost) gives the request's size.
- When the inbox may have missed a turn, it asks the same model to update it
  from the whole conversation. It forks the conversation for this, or reads
  the transcript after a resume.
- To fill the PRs tab, it runs read-only `gh` queries: `gh pr view`, and
  `gh api graphql` for review threads. They reach GitHub under your own `gh`
  sign-in. The inbox never reads your GitHub token.

**Programs it starts.**

| Program | When |
|---|---|
| `gh` | To fill the PRs tab |
| `open` | When you press a button that opens a link, file or folder |
| `test -x` | Before opening a file. An executable file is shown in Finder, not run. |
| `herdr pane report-metadata` | Only inside the Herdr terminal, to show the inbox's counts in its sidebar |

**Messages it sends as you.** When you press an answer or action button, the
inbox sends Claude a message in your name. The message is the answer you
chose, or a request about the item, such as asking Claude to fix a finding.
Resume, on a stopped turn, sends `Continue`. Every message it sends starts
from a press. When you mark a task Done that Claude is waiting on, the inbox
tells Claude a few seconds later, or once Claude's running turn ends.

**What it adds to Claude's context.**

- Its instructions, about 1,350 tokens, in every request.
- A note beside your prompt when you answer one of Claude's numbered
  questions, or when the inbox changed since Claude last saw it.
- Its open items after the conversation is compacted, so Claude keeps them.

**What its hooks see.**

- Tool calls. The inbox reads each call to write the tool lines above, to
  show a question while Claude's question dialog is open, and to find a PR
  this session opens with `gh pr create`. It passes every call on unchanged,
  except calls to its own two tools. `record_finding` saves a finding and
  `close` closes an item. The inbox answers these itself, so they run
  without a permission prompt.
- Permission prompts. While Claude Code asks you to approve a tool call, the
  inbox shows a row for it, then passes the request on unchanged. It never
  approves or denies a permission prompt.
- Tool descriptions. It lists its own two tools to Claude up front, instead
  of behind tool search. It leaves other tools' descriptions alone.
- Shell commands you run with `!`, and their output. A command that runs
  with nothing on stderr closes a task that asked you to run it.
- Session starts. After `/clear`, a resume or a fork, the inbox loads that
  conversation's items. It passes the event on unchanged.
- Your theme setting, to match its colors.

It also adds the `/inbox` command, and keeps its items in Claude Code's
plugin storage on this machine.

## Developing

Read [AGENTS.md](AGENTS.md) first. [docs/looks.md](docs/looks.md) says which
file owns each rule and where the two looks differ on purpose.

Run the mod from a clone:

```sh
claude --plugin-dir /path/to/inbox
```

The session reloads the mod when you change one of its files.

`./scripts/check.sh` runs Prettier, `claude plugin validate`, a type check and
the tests. The type check needs the
types Claude Code writes to `.claude-plugin/types/` the first time it loads
the mod.
