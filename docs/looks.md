# Looks

Status: current. Read this before you change the UI or a business rule.

The inbox has two looks: `terminal` and `desktop`. A look is one way the inbox is drawn, and `GLOSSARY.md` defines it with host, shared module, adapter and difference on purpose. The rule is that shared modules decide and adapters draw. If a rule decides what a row says, which action leads, when a tab counts as empty or what text appears, it lives in a shared module. An adapter decides only how its look draws that.

## Files

Shared modules are in `hooks/`. They import nothing from the engine, and `scripts/check-structure.mjs` checks that. The one exception is a type import from the engine in `hooks/ledger.ts`.

| File | Role |
| --- | --- |
| `hooks/view.ts` | Shared module. The inbox view: Needs you order and count, handles, row state, feedback, done labels, action order, key plan, timing constants. |
| `hooks/presses.ts` | Shared module. The press reducer, its effects, and the saved last-action shape. |
| `hooks/arrivals.ts` | Shared module. Which rows are new, and where a look moves for them. |
| `hooks/ledger.ts` | Shared module. Saved ledger, ledger writes, and the texts the model reads. It also holds Claude-only code and two UI helpers, `ago` and `isLapsed`. |
| `hooks/prs.ts` | Shared module. PR parsing, readiness and prompts. |
| `hooks/pr-tab.ts` | Shared module. The PRs tab's rules: fetching each tracked PR through a host's gh runner, which PRs the tab draws, its row ids, and what each PR press does. |
| `hooks/tools.ts` | Shared module. The record_finding and close tools. |
| `hooks/demo.ts` | Shared module. Sample data for `/inbox demo`. |
| `hooks/layout.ts` | Shared module. Sizes of the desktop look's rows. |
| `hooks/inline.ts` | Shared module. Inline markdown in the agent's text, as spans each look draws. |
| `hooks/register.tsx` | Mod adapter. Draws the terminal and desktop looks, and also runs the band, the PRs tab, the per-reply update and the press runner. |
| `hooks/tabs-client.tsx` | Mod only. A Client region for the desktop tab bar, so each tab takes clicks over its whole shape. |
| `hooks/row-client.tsx` | Mod only. A Client region for a closed row in the desktop pane. |
| `hooks/fold-client.tsx` | Mod only. A Client region for the desktop "N Closed" line. |
| `hooks/links-client.tsx` | Mod only. A Client region for an open row's follow-ups on desktop. |
| `hooks/undo-client.tsx` | Mod only. A Client region for Undo on desktop, whose fill drains while Undo lasts. |

## Who owns each rule

Change a rule in its owner. Do not change it in a reader.

| Rule | Owner | Read by |
| --- | --- | --- |
| Needs you order and count | `hooks/view.ts:needsYouOrder`, `hooks/view.ts:inboxView` | Both looks, the band and the status line |
| Question handles | `hooks/ledger.ts:questionNumbers`, read by `hooks/view.ts:inboxView` | The terminal look only. It draws `1)` or `•`. Desktop draws no handle on a question. |
| Finding groups and handles | `hooks/view.ts:FINDING_GROUPS`, `hooks/view.ts:drawnLists` | Both looks. Each lists findings under an Issues and an Opportunities title and draws the kind's mark as the handle. A handed-off finding draws ✓ instead. |
| Row state | `hooks/view.ts:RowState`, `hooks/presses.ts:isHandedOff` | Both looks |
| Which row opens: by default, when rows arrive above it, and after a press closes the open row | `hooks/view.ts:firstWaiting`, `hooks/view.ts:keptOpen`, `hooks/view.ts:rowAfterClose` | Both looks |
| Feedback text | `hooks/view.ts:feedbackText`, `hooks/view.ts:feedbackOf` | Terminal and desktop through the pane |
| Done labels | `hooks/view.ts:DONE_LABELS` | Both looks |
| Action order | `hooks/view.ts:actionsOf` | Both looks |
| Key plan | `hooks/view.ts:rowKeyPlan` | Both looks take the order. Terminal draws the key letters. Desktop draws labels only. |
| Press reducer and effects | `hooks/presses.ts:applyPress`, `hooks/presses.ts:runLocalEffects`, `hooks/presses.ts:runSends` | The mod |
| Settle window | `hooks/view.ts:SETTLED_MS`, `hooks/view.ts:settleWindowMs` | The mod passes `SETTLED_MS`. |
| Closed fold size | `hooks/view.ts:CLOSED_SHOWN`, `hooks/view.ts:closedShown` | Both looks |
| Options fold size | `hooks/view.ts:OPTIONS_FOLD_AT` | Both looks through `actionsOf` |
| New rows and where a look moves | `hooks/arrivals.ts:recordRows`, `hooks/arrivals.ts:followTo` | The pane |
| Press guard | `hooks/view.ts:PRESS_GUARD_MS` | Both looks |
| Row padding | `hooks/layout.ts:ROW_PAD_PT` | Desktop |
| Demo data | `hooks/demo.ts:demoView` | The mod's `/inbox demo` |
| Model-read texts | `hooks/ledger.ts:guidanceText`, `hooks/ledger.ts:systemText`, `hooks/ledger.ts:inboxText`, `hooks/ledger.ts:promptNotes`, `hooks/tools.ts:findingDescription` | The mod, through `hooks/ledger.ts:CLAUDE_CODE` |
| Saved state shapes and upgrades | `types/index.d.ts:PluginState`, `hooks/ledger.ts:upgradeLedger`, `hooks/presses.ts:upgradeLastActions` | The mod also uses `hooks/register.tsx:upgradeState`. |
| PR readiness and prompts | `hooks/prs.ts:readiness`, `hooks/prs.ts:prompts` | The mod |
| PR presses, which PRs the tab draws, and how a PR is fetched | `hooks/pr-tab.ts:applyPrPress`, `hooks/pr-tab.ts:drawnPrs`, `hooks/pr-tab.ts:fetchTracked` | The mod |

## Differences on purpose

A difference is on purpose when a look cannot do something or the product decided it. Anything not listed here is drift.

| Topic | Terminal | Desktop | Why | Where |
| --- | --- | --- | --- | --- |
| Keys | Button hotkeys work. The key letter is drawn before the label. Explain has a key and no button, so it does not crowd a row's answers. | Clicks only. Button hotkeys do nothing, and no letter is drawn. Explain is a button beside Reply and Dismiss. | The desktop pane takes no key input. | `hooks/register.tsx:keyedButton`, `hooks/view.ts:rowKeyPlan` |
| Hit areas | Character cells. | A Button takes a click only over its label. A Client region takes clicks over a whole shape. | The engine draws desktop Buttons label-sized. | `hooks/row-client.tsx:RowProps`, `hooks/tabs-client.tsx:TabsProps` |
| Motion and bars | Undo's fill drains by cells until the row leaves. A just-closed row without Undo shows a bar that shrinks by half cells. No animation. | Undo's fill drains while it lasts. No leave bar and no animation. | The pane has no opacity, transform or CSS. | `hooks/register.tsx:leaveBar`, `hooks/undo-client.tsx` |
| Redraw | Redraws in steps while a row leaves. | Redraws once when a row leaves. A timer redraw loop made clicks fail. | Clicks in the desktop pane fail under a redraw loop. | `hooks/register.tsx:redrawWhileLeaving` |
| Primary buttons | None. A plain terminal Button ignores `variant`. The recommended option ends "(recommended)". | The recommended option, Done and Address. | `docs/plans/inbox-ui.md` says the desktop pane makes the recommended option, or else Done or Address, the primary button. | `hooks/register.tsx:keyedButton` |
| Finding path display | The file name, in Claude Code's inline-code color. | Same as terminal. The pane has no font props. | The full path is long and shows a private folder. | `hooks/register.tsx:findingRow` |
| Clipping | The adapter clips to the cell width, one character per cell. | The adapter clips with a measured characters-per-cell estimate. | Shared text is never pre-shortened. Each adapter knows its own width. | `hooks/register.tsx:rowClientProps`, `hooks/register.tsx:DESKTOP_CLIP_CHARS_PER_CELL` |
| Closed row age | Always drawn. | Dropped below 50 columns. | A narrow desktop pane has no room for it. | `hooks/register.tsx:DESKTOP_WIDE_AT` |
| Tab placement | Inline from 80 columns, a column at the pane's left beside the rows. Docked or narrower, a row above them. | A row above the rows. | Inline, a row of tabs lines up with the group titles under it and reads as one more title. Docked tabs have their own fill and line. A column narrower than 80 leaves the rows too little room. | `hooks/register.tsx:INLINE_RAIL_AT` |
| Tab counts | Always drawn. Tabs that don't fit wrap to a second line. | Dropped when the tabs with counts don't fit on one line, below about 38 columns. | The desktop tabs are one Client region of fixed height, so they cannot wrap. | `hooks/register.tsx:desktopTabSizes` |
| Colors | The Claude Code theme's palette. | Hex palettes for the dark and light themes, else translucent gray fills. | Each look matches its host app. | `hooks/register.tsx:paletteFor` |
| `/inbox` during a turn | Runs at once. | Waits until the turn ends. | The command is registered `immediate`. The desktop app sends a typed command through Claude Code's prompt queue, which holds it until the turn ends whatever `immediate` says, as checked in Claude Code 2.1.296. | `hooks/register.tsx:turnOn` |
| Look for mobile and VS Code | Used. | Not used. | The engine's `surface` can be `mobile` or `vscode`, which nobody has checked. They get the terminal look. | `hooks/register.tsx:lookOf` |

## After you change X, check Y

State in your change, for each look, whether it applies and what you checked.

| Change | Edit | Then check |
| --- | --- | --- |
| A row action | `hooks/view.ts:actionsOf`, `hooks/presses.ts:applyPress`, and `hooks/view.ts:DONE_LABELS` for its label | The action appears in terminal and desktop. Check Undo, failure and key letters. Add the case to `tests/hooks.test.ts` when the repo's coverage expects it. |
| A row field | `hooks/view.ts:inboxView` and the `RowView` type, then `itemRow` and `findingRow` in `hooks/register.tsx` | Both looks draw the field. |
| A word on screen | The shared string in `hooks/view.ts` or `hooks/presses.ts`, else `hooks/register.tsx` | Run the change through the `refine-prose` skill. Check each look for clipping. |
| Model-read text | `hooks/ledger.ts` or `hooks/tools.ts` | A/B test it with Sonnet as `AGENTS.md` says. |
| A saved field | `types/index.d.ts:PluginState`, then `hooks/ledger.ts:upgradeLedger` or `hooks/register.tsx:upgradeState` | Load a state saved by the old build in the mod. |
| A size or timing | `hooks/view.ts` constants or `hooks/layout.ts:ROW_PAD_PT`, else the adapter's own constant | Measure in the terminal and desktop. Add a row to Differences on purpose when the values differ. |
| A tab | `hooks/view.ts:TABS` and `hooks/view.ts:ROW_TABS` | The mod pane and the empty text in `hooks/view.ts:emptyText`. |
| A PR feature | `hooks/prs.ts` and `hooks/pr-tab.ts:applyPrPress` | Both looks. Check the PRs tab in each. |

## Checks

`scripts/check-structure.mjs` fails when a shared module imports the engine or a file in `hooks/` that is not a shared module. It also fails on a plan with no status line, a doc that names a missing file, and a `file:symbol` in this file that does not exist. The symbol check passes when the file contains the word anywhere, so it does not prove a definition. `./scripts/check.sh` runs the script with prettier, plugin validation, type checks and the mod tests. Run `./scripts/check.sh` after every change.
