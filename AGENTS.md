# Working on the inbox

The inbox is drawn in two looks: the Claude Code terminal and the Claude desktop app's pane. Before you change the UI or a rule, read [docs/looks.md](docs/looks.md). It says which file owns each rule, where the looks differ on purpose, and what to check after each kind of change. [GLOSSARY.md](GLOSSARY.md) defines the terms.

## Every change

- The repo is public. Keep private paths, other people's names and session content out of commits.
- Run `./scripts/check.sh` after every change.
- Change a rule in the file that owns it, never in one look's drawing code. Shared modules in `hooks/` decide; `hooks/register.tsx` only draws. A change to a shared module reaches both looks.
- When you finish a change to a shared module or a look's drawing code, say for each look whether the change applies and what you checked there. A difference between looks that is not in the "Differences on purpose" table in `docs/looks.md` is drift: fix it, or add it to the table with its reason.
- Saved state outlives the code. Its shape is `PluginState` in `types/index.d.ts`. When a saved shape changes, convert old state in `upgradeLedger` or `upgradeState`.

## Text a model reads

Test a change to text a model reads before keeping it. Small rewordings change behavior: a one-word edit to the findings rule in `systemText` made the inbox model re-add questions the user had dismissed.

- Claude reads the guidance `guidanceText` builds, and the `inbox:` texts that `inboxText`, `closedText`, `carryText` and `answerNote` build, all in `hooks/ledger.ts`. `CLAUDE_CODE`, a `Host`, supplies its names and the guidance's first paragraph.
- Claude reads the tool descriptions and results from `hooks/tools.ts`.
- The inbox model reads `systemText` and the blocks from `buildPrompt` in `hooks/ledger.ts`. It is a Sonnet call after each reply.
- To compare two versions, print each one's prompt for the same sample exchange. Run each several times with `claude -p --model sonnet --tools "" --system-prompt …`. Count the outcomes.
- After a change to `systemText` or `buildPrompt`, run `./scripts/eval.sh`. It runs the inbox model on the cases in `evals/cases.json` on Sonnet, and fails a case that passes in too few runs. Add a case for each behavior a change sets out to fix. `check.sh` leaves the evals out, since each run calls a model.

## Presses

Every action shows what it did as soon as it is pressed. When Discuss showed nothing, a person sent the same message four or five times.

- Each `Action` declares its `kind`, a `PressKind`.
- A Talk or Hand-off press leaves a ✓ and its label on the row, as in "✓ Discussed". A Talk press reads "Explaining…" or "Discussing…" until the agent's reply, and a handed-off row the reply left open reads "Still open". It stores its action id from `actionId()`, so the same action then reads "… again".
- A Local press, an open or a copy, shows "Opening x…" on its row, then its result: "✓ Opened x", or in red why it could not. It never reports through a toast.
- A Mark or View press shows itself, as closing a row or opening the text field does.
- Every Button's press runs `runPress()`. It applies a row press with `applyPress()` and a PR press with `applyPrPress()`, then records the row's last action, so a click and a key press record the same.

## Tests and live checks

- In `tests/hooks.test.ts`, `world()` answers every engine event the mod uses, and the test harness takes one handler per event. A test changes an answer through the variables `world()` resets, such as `ledgerReply`, `stopBlock` and `ghAnswers`.
- The plugin store is keyed by the mod's name, so a session that loads a copy under your own config writes to your real inbox's state. Check the UI live in a session with its own `CLAUDE_CONFIG_DIR`. `mods/scripts/live.sh` in petekp/claude-code-setup starts one in tmux.
- To try a change with real model turns, run `claude -p` on a copy of the mod. Patch the copy to turn on, since the mod does nothing under `-p`, and to skip its `$.store` writes, since the run signs in with your own config and would save the trial's sessions to your real inbox.
- To test whether the agent calls `record_finding` or `close`, give `claude -p` a stand-in MCP server through `--strict-mcp-config --mcp-config`. Name the server anything but `inbox`. A server named `inbox` lets the real mod answer the calls and save them to your real inbox.

## Drawing in each look

- **Every look.** Check every state of what you change, and every move between states, not only the resting forms. Look at frames mid-move. A button must not shift while its press is out, content must not vanish before its space closes, and nothing may flicker. Then look in the real app. Say which states you did not see.
- **Every look.** The desktop pane's sizes, such as row padding, live in `hooks/layout.ts`.
- **Terminal.** The terminal and desktop looks share `hooks/register.tsx`, so a change there for the desktop app can change the terminal too. Check it there.
- **Desktop.** Before designing for the Claude app's pane, read "Drawing limits for desktop design" in `docs/reference/claude-desktop-app.md`. Build only on what it marks verified or stated, and probe anything it marks unknown. A Button there is always native and as small as its label, and its hotkey does nothing. A custom-drawn control that takes clicks over its whole shape needs a `Client`. The pane has no opacity, transform or CSS, so a row changes form in one draw. The pane redraws only on events, so confirm it shows the new build before trusting a capture.
