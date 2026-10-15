// The mod: the host and the adapter for the terminal and desktop looks. It owns the engine hooks, the atoms,
// the press runner, the PR presses and fetches, the band above the prompt and the /inbox pane. Rules shared
// with other surfaces live in view.ts, presses.ts, arrivals.ts, ledger.ts, prs.ts, tools.ts, demo.ts and layout.ts;
// this file only draws them. See GLOSSARY.md for the terms and docs/looks.md for who owns each rule.
//
// Find a section by searching for:
//   atoms and constants: `const LEDGER`; palettes: `const PALETTES`; the look of a surface: `function lookOf`
//   model-read guidance: `guidanceText` in hooks/ledger.ts; per-reply update: `function runUpdate`, `function queueUpdate`
//   stop and dialogs: `function setStop`, `function openDialog`; PR fetches: `function fetchPrs`
//   PR presses: `applyPrPress` in pr-tab.ts; press runner: `async function runPress`; demo: `runDemoPress`
//   engine hooks: `export const register`; band: `component: 'AbovePrompt'`; pane: `component: 'Pane'`
//   desktop Clients: `const hasClient`; PR block in the pane: `const prBlock`

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionAppendMessage,
  UiCopyResult,
  RenderSurface,
  UiPressArgument,
  UiScrollResult,
} from 'claude-code'

import type {
  Cursor,
  Closed,
  DemoCopy,
  Dialog,
  FoldKind,
  Item,
  Ledger,
  Finding,
  PrCheck,
  PrThread,
  PrView,
  PrViews,
  Presence,
  LastAction,
  PressKind,
  RowNote,
  Stop,
  Tab,
} from '../types'
import { demoView, isDemoCopy } from './demo'
import type { Exchange, Press, Update } from './ledger'
import {
  applyPrPress,
  drawnPrs,
  fetchTracked,
  isDismissing,
  isTracked,
  linkedPrs,
  olderPrsText,
  PR_TONES,
  prCheckId,
  prMarkId,
  prRetryOf,
  prRowId,
  prRowWaits,
  prThreadId,
  threadSentIn,
} from './pr-tab'
import type { Applied, GhRun, PrPress } from './pr-tab'
import {
  commentLine,
  commentParts,
  failingChecks,
  prRefs,
  prNeedsYou,
  threadsOnYou,
  readableComment,
  readiness,
  THREAD_TITLE_CHARS,
  threadWhere,
  took,
  waitingThreads,
} from './prs'
import {
  EMPTY,
  ago,
  applyUpdate,
  buildPrompt,
  carryText,
  closeItem,
  commandRowLine,
  dialogLine,
  parseReply,
  catchUpPrompt,
  CLAUDE_CODE,
  guidanceText,
  closedState,
  promptNotes,
  resetTime,
  readCommandRow,
  readKind,
  screenText,
  START_TITLE,
  statusLine,
  stopFix,
  stopKindOf,
  stopText,
  systemText,
  tasksRunBy,
  toolActivity,
  transcriptCatchUpPrompt,
  transcriptText,
  TOLD_NOTHING,
  type Told,
  upgradeLedger,
} from './ledger'
import {
  applyPress,
  baseName,
  capitalized,
  clipLabel,
  demoRecord,
  demoTurns,
  doneWake,
  localPath,
  markSentToAgent,
  openCommands,
  prSteps,
  runLocalEffects,
  runSends,
  stepIconKind,
  upgradeLastActions,
  withArrival,
  withLasts,
  withRewrite,
} from './presses'
import type { Effect, EffectHost, HelpStep, PrActionId, RowPress } from './presses'
import {
  closedShown,
  DOT,
  drawnLists,
  emptyText,
  ROW_TABS,
  TABS,
  CLOSED_MARKS,
  FINDING_GROUPS,
  DEMO_NOTICE,
  groupEmptyText,
  closedTotal,
  earlierLabel,
  entryId,
  foldLabel,
  feedbackOf,
  feedbackText,
  hasAge,
  inboxView,
  isFailure,
  isGuarded,
  perTurnStatus,
  PRESS_GUARD_MS,
  QUEUED_AFTER_MS,
  rowKeyPlan,
  rowsIn,
  SETTLED_MS,
  settledIn,
  settledRowIds,
  allRows,
  firstWaiting,
  keptOpen,
  listWaits,
  rowAfterClose,
  shortAgo,
} from './view'
import type { DrawnEntry, InboxView, Look, PlannedKey, RowView, RowWait } from './view'
import {
  CLOSE_DESCRIPTION,
  CLOSE_SCHEMA,
  FINDING_SCHEMA,
  findingDescription,
  recordClose,
  recordFinding,
} from './tools'
import type { UndoProps } from './undo-client'
import { followTo, recordRows } from './arrivals'
import { parseInline } from './inline'
import type { RowRecord } from './arrivals'
import { ROW_PAD_PT } from './layout'
import { DARK_DALTONIZED_TONES, DARK_TONES, LIGHT_DALTONIZED_TONES, LIGHT_TONES, toneColors } from './tones'
import type { ToneName } from './tones'
import type { FoldProps } from './fold-client'
import type { LinksProps } from './links-client'
import type { RowProps } from './row-client'
import { TAB_COUNT_GAP, TAB_HEIGHT, type TabsProps } from './tabs-client'

const LEDGER = atom({ plugin: 'inbox', key: 'ledger' } as const, EMPTY)
const PRESENCE = atom(
  { plugin: 'inbox', key: 'presence' } as const,
  {
    lastActiveAt: 0,
    isAway: false,
    isUpdating: false,
    ledgerState: 'current',
    turnsStarted: 0,
    turnsApplied: 0,
    minute: 0,
  } as Presence,
)
const TAB = atom({ plugin: 'inbox', key: 'tab' } as const, 'needsYou' as Tab)
const NO_CURSOR: Cursor = { id: null, index: 0, openedAt: 0 }
const NO_SELECTION: Record<Tab, Cursor> = { needsYou: NO_CURSOR, findings: NO_CURSOR, prs: NO_CURSOR }
const SELECTION = atom({ plugin: 'inbox', key: 'selection' } as const, NO_SELECTION)
// Whether Claude Code uses its `dark` theme, which picks the selected row's tint.
const THEME = atom({ plugin: 'inbox', key: 'theme' } as const, '')
const PR_VIEWS = atom(
  { plugin: 'inbox', key: 'prViews' } as const,
  { views: {}, branchRef: null, isFetching: false } as PrViews,
)
const STOP = atom({ plugin: 'inbox', key: 'stop' } as const, null as Stop | null)
const DIALOGS = atom({ plugin: 'inbox', key: 'dialogs' } as const, [] as Dialog[])
const TYPING = atom({ plugin: 'inbox', key: 'typing' } as const, null as string | null)
const DRAFTS = atom({ plugin: 'inbox', key: 'drafts' } as const, {} as Record<string, string>)
const NOTES = atom({ plugin: 'inbox', key: 'notes' } as const, {} as Record<string, RowNote>)
const LAST_ACTIONS = atom({ plugin: 'inbox', key: 'lastActions' } as const, {} as Record<string, LastAction>)
const UNFOLDED = atom({ plugin: 'inbox', key: 'unfolded' } as const, [] as FoldKind[])
const FOLD_HOVER = atom({ plugin: 'inbox', key: 'foldHover' } as const, null as FoldKind | null)
const OPTIONS_SHOWN = atom({ plugin: 'inbox', key: 'optionsShown' } as const, [] as string[])
const IS_KEY_LIST_SHOWN = atom({ plugin: 'inbox', key: 'isKeyListShown' } as const, false)
const UNREADABLE = atom({ plugin: 'inbox', key: 'unreadable' } as const, null as string | null)
// The bar under a just-closed row, in cells. It loses half a cell per step of SETTLED_MS, so the pane redraws that often.
const LEAVE_BAR_CELLS = 12
const LEAVE_BAR_STEPS = LEAVE_BAR_CELLS * 2
// After a resize, how long the inline pane waits before it scrolls back to the open row.
const RESIZE_SCROLL_MS = 100
const DEMO = atom({ plugin: 'inbox', key: 'demo' } as const, null as DemoCopy | null)
const DEMO_RECORDING = atom({ plugin: 'inbox', key: 'isDemoRecording' } as const, false)
const TOOLS_REFUSED_TEXT =
  "Claude cannot record or close items here: your organization's settings block the inbox's tools."
const PR_POLL_MS = 2 * 60_000

const FINDING_TOOL = 'mcp__inbox__record_finding'
const CLOSE_TOOL = 'mcp__inbox__close'

const PANE = 'inbox'
// Whether the desktop pane offers a typed reply. Set it false if the app does not paint `Input`: the engine still resolves it, so the mod cannot tell.
const DESKTOP_TYPING = true
// From this many columns, the desktop pane shows each closed row's age.
const DESKTOP_WIDE_AT = 50
// About how many characters of desktop's proportional text fit in one column of `bodyColumns`: sentences and
// the tab labels run 1.23 to 1.30, bold or not. A guess too high is cut from the muted text after a title.
const DESKTOP_CHARS_PER_CELL = 1.25
// A lower guess for text that must stay one line, since desktop wraps text that is too long. A run of wide
// letters such as "n" runs about 1.03.
const DESKTOP_CLIP_CHARS_PER_CELL = 1.1
const DESKTOP_TAB_PAD = '\u00a0'.repeat(3)
// A text line in the Claude app pane, in points: a one-line row padded by half a line above and below
// is 37.8 pt.
const DESKTOP_LINE_PT = 19
// One column of `bodyColumns` in the Claude app pane, in points: 15.8 px at 2x.
const DESKTOP_CELL_PT = 7.9
// The desktop Undo button's width, in columns.
const UNDO_CELLS = 9
// The app's own buttons in the pane: 23 pt tall, corners of 6 pt and a 14 px label. Dark:
// a 10% white fill and #f0efec text. Light: a near-white fill, a 1 pt outline about 10% black, and #0b0b0b text.
const UNDO_HEIGHT_PT = 23
/**
 * The desktop Undo button, drawn to look like the app's own buttons. The part of its fill that is time left is
 * the button's full fill, and the part used up is half as strong. The used-up part grows from `1 - fraction` to
 * the whole width over `leftMs`. The app draws an Svg as an image, which runs SMIL animation, so the fill moves
 * without the pane redrawing. An image cannot read the app's theme, so it follows the color scheme instead.
 */
function undoSvg(fraction: number, leftMs: number): string {
  const w = UNDO_CELLS * DESKTOP_CELL_PT
  const h = UNDO_HEIGHT_PT
  const left = (w * fraction).toFixed(1)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<style>.used{fill:rgba(255,255,255,0.6)}.left{fill:rgba(0,0,0,0.06)}.edge{fill:none;stroke:rgba(0,0,0,0.1)}` +
    `text{fill:#0b0b0b}@media (prefers-color-scheme: dark){.used{fill:rgba(255,255,255,0.05)}` +
    `.left{fill:rgba(255,255,255,0.1)}.edge{stroke:none}text{fill:#f0efec}}</style>` +
    `<clipPath id="shape"><rect width="${w}" height="${h}" rx="6"/></clipPath>` +
    `<g clip-path="url(#shape)"><rect class="used" width="${w}" height="${h}"/>` +
    `<rect class="left" width="${left}" height="${h}">` +
    `<animate attributeName="width" from="${left}" to="0" dur="${leftMs}ms" fill="freeze"/></rect></g>` +
    `<rect class="edge" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="5.5"/>` +
    `<text x="${w / 2}" y="${h / 2}" dominant-baseline="central" text-anchor="middle" ` +
    `font-family="-apple-system, system-ui, sans-serif" font-size="14">↺ Undo</text></svg>`
  )
}
/**
 * Desktop text in a status color, as an Svg one line tall and `cells` wide. Text draws one color in both
 * appearances, which the mod cannot read, but an Svg follows the system's light or dark setting, so this takes the
 * shared tone for each. It draws `mark`, then `label` two columns on, as a row's mark column
 * and text sit; either may be ''.
 */
function toneSvg(tone: ToneName, mark: string, label: string, cells: number): string {
  const { light, dark } = toneColors(tone)
  // A marker needs only 3:1, so an error mark takes a stronger red than text could.
  const [lightMark, darkMark] = tone === 'error' ? [LIGHT_TONES.errorMark, DARK_TONES.errorMark] : [light, dark]
  const w = cells * DESKTOP_CELL_PT
  const h = DESKTOP_LINE_PT
  const shape = markShape(mark, h / 2)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<style>text{font-family:-apple-system,system-ui,sans-serif;font-size:14px;fill:currentColor}` +
    `.mark{color:${lightMark}}.label{color:${light}}` +
    `@media (prefers-color-scheme: dark){.mark{color:${darkMark}}.label{color:${dark}}}</style>` +
    (shape === null
      ? `<text class="mark" x="0" y="${h / 2}" dominant-baseline="central">${escapeXml(mark)}</text>`
      : `<g class="mark">${shape}</g>`) +
    (label
      ? `<text class="label" x="${mark ? 2 * DESKTOP_CELL_PT : 0}" y="${h / 2}" dominant-baseline="central">` +
        `${escapeXml(label)}</text>`
      : '') +
    `</svg>`
  )
}
/**
 * A row mark drawn as a shape, 8 pt square and centered on `midY`, so it looks the same whatever font the Svg
 * falls back to. The app's own font cannot load in an Svg, and the system font's ✓ is a thin "v". Null for a mark
 * with no shape here, which draws as text.
 */
function markShape(mark: string, midY: number): string | null {
  const t = midY - 4
  const stroke = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"'
  switch (mark) {
    case '✓':
      return `<polyline points="0.6,${t + 4.4} 3,${t + 6.8} 7.4,${t + 1.4}" ${stroke}/>`
    case '✕':
    case '✗':
      return `<path d="M1,${t + 1} L7,${t + 7} M7,${t + 1} L1,${t + 7}" ${stroke}/>`
    case '▲':
      return `<polygon points="4,${t + 0.6} 7.8,${t + 7.4} 0.2,${t + 7.4}" fill="currentColor"/>`
    case '✦':
      return (
        `<path d="M4,${t} Q4.6,${t + 3.4} 8,${t + 4} Q4.6,${t + 4.6} 4,${t + 8} ` +
        `Q3.4,${t + 4.6} 0,${t + 4} Q3.4,${t + 3.4} 4,${t} Z" fill="currentColor"/>`
      )
    default:
      return null
  }
}
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
/** The cells a label of `text` takes, counted high, so an Svg sized by it never cuts the label. */
function labelCells(text: string): number {
  return Math.ceil(text.length / (DESKTOP_CHARS_PER_CELL - 0.15)) + 1
}
/**
 * The chevron in a desktop fold line's mark column: right while folded, down while unfolded. It is an Svg, the
 * only icon the pane can draw, sized to the fold line, so it sits in the mark column at the line's middle.
 */
function chevronSvg(isUnfolded: boolean, isHover: boolean): string {
  const w = FRAME_INSET_PT + DESKTOP_MARK_CELLS * DESKTOP_CELL_PT
  const h = 2 * ROW_PAD_PT + DESKTOP_LINE_PT
  // At the column left of the mark column, where the rows' marks hang.
  const x = FRAME_INSET_PT - DESKTOP_CELL_PT + 0.5
  const y = h / 2
  const points = isUnfolded
    ? `${x},${y - 2} ${x + 3.5},${y + 1.5} ${x + 7},${y - 2}`
    : `${x + 1.5},${y - 3.5} ${x + 5},${y} ${x + 1.5},${y + 3.5}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    // At rest, the fold label's dim gray; under the pointer, the app's text color, as the label turns.
    (isHover
      ? `<style>polyline{stroke:#0b0b0b}@media (prefers-color-scheme: dark){polyline{stroke:#f0efec}}</style>`
      : `<style>polyline{stroke:${DESKTOP_AGE}}</style>`) +
    `<polyline points="${points}" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  )
}
/**
 * A desktop row's padding above and below its text, in a Client's lines: the shared ROW_PAD_PT. The rows sit
 * flush. A Box in the hooks tree counts padding in half lines, so it pads twice this.
 */
const DESKTOP_ROW_PAD = ROW_PAD_PT / DESKTOP_LINE_PT
// In the terminal, the column a section's title starts at and its tree's │ runs in, so the line hangs from the
// middle of the title's first letter. A box-drawing line sits mid-cell, and a title one column further on would
// leave it half a cell to the letter's left.
const TREE_LINE_AT = 2
/**
 * Where a row's handle and its text start, in columns. In the terminal, a group's tree runs its │ in the lead, and a
 * flat row, as Findings lists them, has a 1-column lead. Desktop draws no tree, so every list there uses `desktop`,
 * and section titles and Closed folds start at its handle column. The open row, the closed row's Client and the
 * settled row all draw at these columns, so a row's title stays put as it opens, closes or settles.
 */
const ROW_COLUMNS = {
  // The tree's ├─ and a blank, then the 3-column handle.
  tree: { lead: TREE_LINE_AT + 3, handleAt: TREE_LINE_AT + 3, textAt: TREE_LINE_AT + 6 },
  flat: { lead: 1, handleAt: 3, textAt: 5 },
  desktop: { lead: 1, handleAt: 1, textAt: 3 },
} as const
// A desktop list line's mark column and its side column, for the age, in columns.
const DESKTOP_MARK_CELLS = 1
// How far a row frame's transparent border insets its content, in points.
const FRAME_INSET_PT = 13.2
const DESKTOP_SIDE_CELLS = 5
// The terminal row's side column: a short age, as "27m", with a cell on each side.
const TERMINAL_SIDE_CELLS = 5
const SELECTED_GAP_PT = 3
// The terminal's `after` follows a row's title on its line, after a dot; desktop draws it on its own line.
const LEADING_DOT = new RegExp(`^${DOT}`)
// Theme keys, so the colors follow the person's Claude Code theme.
const NEEDS_YOU = 'warning'
// A child's place under its section: a middle child, the last, or a block the tree passes.
type TreePos = 'mid' | 'last' | 'pass'
// More tree lines than a row wraps to; the tree's Box clips the rest.
const TREE_DEPTH = 200
// The bar that marks a selected row where the palette has no selection color.
const SELECTION_BAR = Array<string>(TREE_DEPTH).fill('▌').join('\n')
// The tree column's text for each place and lead, built once each.
const treeTexts = new Map<string, string>()

/** The tree column for a row: `lead` lines of │, its branch, then │ or blank below. */
function treeText(pos: TreePos, lead: number): string {
  const key = `${pos}:${lead}`
  const cached = treeTexts.get(key)
  if (cached !== undefined) return cached
  const text = [
    ...Array<string>(lead).fill('│'),
    pos === 'last' ? '└─' : pos === 'mid' ? '├─' : '│',
    ...Array<string>(TREE_DEPTH).fill(pos === 'last' ? ' ' : '│'),
  ].join('\n')
  treeTexts.set(key, text)

  return text
}
const DONE = 'success'
const FINDINGS = 'autoAccept'
const PRS = 'planMode'

// A status color in the pane. Each tab has the tone of its own name.
type Tone = Tab | 'issue' | 'done' | 'error'
/**
 * The pane's colors in one Claude Code theme. Each text color meets WCAG AA,
 * 4.5:1, on every background the pane draws it on, and each marker meets 3:1.
 * The terminal draws Button labels in its own text color, and the theme's dim
 * gray for `dimColor`, so the pane gives Buttons no dimColor. The footer's Keys
 * toggle and the Closed and Details folds are the exceptions: secondary
 * controls, they brighten under the pointer. So are a just-opened row's
 * buttons, dim while they ignore clicks.
 */
type Palette = {
  /** Painted under the whole pane, over the theme's own background. */
  body?: string
  /** The sections' cards. */
  card?: string
  /** An unselected tab's panel. */
  tab?: string
  /** The selected tab's panel, and an unselected tab's under the pointer. */
  raised: string
  /** The text on `raised`; without one, the default text color. */
  raisedText?: string
  /** The selected row's background. Without one, a bar in `key` marks the row. */
  selection?: string
  /** Secondary text: ages, counts, labels and closed items. */
  muted: string
  /**
   * A closed row's age on its card, dimmer than `muted` where the palette has room. It meets 4.5:1 on `card`
   * alone, so a row under the pointer or selected draws its age in `muted`.
   */
  age: string
  /** The letters of a selected row's keys. */
  key: string
  /** The tree's lines. */
  line: string
  /** The tree's lines on `selection`, in its hue. Without one, `line`. */
  selectionLine?: string
  /** The rules between rows. */
  divider: string
  /** Text in a status color. A tone left out draws its text in the default color. */
  tone: Partial<Record<Tone, string>>
  /** A marker in a status color, such as ✓. */
  mark: Record<Tone, string>
}

const DARK_PALETTE: Palette = {
  card: '#373737',
  tab: '#373737',
  raised: '#4c4c4c',
  selection: '#3b4654',
  muted: '#bdbdbd',
  age: '#a3a3a3',
  key: DARK_TONES.key,
  line: '#505050',
  selectionLine: '#5a6f88',
  divider: '#444444',
  tone: DARK_TONES,
  mark: { ...DARK_TONES, error: DARK_TONES.errorMark },
}
const LIGHT_PALETTE: Palette = {
  card: '#e6e6e6',
  tab: '#e6e6e6',
  raised: '#d0d0d0',
  selection: '#b4d5ff',
  muted: '#595959',
  age: '#666666',
  key: LIGHT_TONES.key,
  line: '#afafaf',
  selectionLine: '#7490b8',
  divider: '#c8c8c8',
  tone: LIGHT_TONES,
  mark: LIGHT_TONES,
}
// The ANSI themes take the terminal's 16 colors, and Claude Code draws the
// pane on a palette gray that default text fails against. The pane paints its
// own body in the palette color nearest the terminal's background, draws text
// only in the default and muted colors, and puts status colors on markers.
// A color name such as "black" is drawn as fixed RGB, so each color is a theme
// key whose value in that ANSI theme is the palette color named beside it.
const DARK_ANSI_PALETTE: Palette = {
  body: 'inverseText', // black
  raised: 'inactive', // white
  raisedText: 'inverseText', // black
  muted: 'inactive', // white
  age: 'inactive',
  key: 'suggestion', // bright blue
  line: 'userMessageBackground', // bright black
  divider: 'userMessageBackground',
  tone: {},
  mark: { needsYou: NEEDS_YOU, issue: NEEDS_YOU, findings: FINDINGS, prs: PRS, done: DONE, error: 'error' }, // the bright colors
}
const LIGHT_ANSI_PALETTE: Palette = {
  body: 'userMessageBackgroundHover', // bright white
  raised: 'text', // black
  raisedText: 'userMessageBackgroundHover', // bright white
  muted: 'inactive', // bright black
  age: 'inactive',
  key: 'suggestion', // blue
  line: 'userMessageBackground', // white
  divider: 'userMessageBackground',
  tone: {},
  // Red, magenta, blue, green and red: the theme's yellow and cyan fall under 3:1 on bright white.
  mark: { needsYou: 'error', issue: 'error', findings: FINDINGS, prs: 'suggestion', done: DONE, error: 'error' },
}
const PALETTES: Record<string, Palette> = {
  dark: DARK_PALETTE,
  'dark-daltonized': {
    ...DARK_PALETTE,
    key: DARK_DALTONIZED_TONES.key,
    tone: DARK_DALTONIZED_TONES,
    mark: { ...DARK_DALTONIZED_TONES, error: DARK_DALTONIZED_TONES.errorMark },
  },
  light: LIGHT_PALETTE,
  'light-daltonized': {
    ...LIGHT_PALETTE,
    card: '#dcdcdc',
    tab: '#dcdcdc',
    raised: '#c8c8c8',
    muted: '#545454',
    age: '#5e5e5e',
    key: LIGHT_DALTONIZED_TONES.key,
    divider: '#c0c0c0',
    tone: LIGHT_DALTONIZED_TONES,
    mark: LIGHT_DALTONIZED_TONES,
  },
  'dark-ansi': DARK_ANSI_PALETTE,
  'light-ansi': LIGHT_ANSI_PALETTE,
}
// Auto and custom themes: theme keys whose values pass in both Claude Code's
// dark and light themes, since the mod cannot tell which one Auto chose. Text
// sits on the pane's own background, as in the ANSI palettes.
const THEME_KEY_PALETTE: Palette = {
  tab: 'userMessageBackground',
  raised: 'subtle',
  raisedText: 'text',
  muted: 'inactive',
  age: 'inactive',
  key: 'remember',
  line: 'subtle',
  divider: 'subtle',
  tone: {},
  mark: { needsYou: NEEDS_YOU, issue: NEEDS_YOU, findings: FINDINGS, prs: PRS, done: DONE, error: 'error' },
}
// The desktop app picks its own light or dark appearance, which the mod cannot read, and Claude Code's theme does
// not follow it. Theme keys resolve to the app's colors, so the desktop pane draws text in theme keys. The app keeps
// its sections on its own background and marks a selected row with a warm gray, #ecebe8 on its light page. No theme
// key draws that gray, so a translucent warm gray does: about #edece9 over the light pane and #2d2b29 over the dark
// one. The app refuses an hsl() alpha or color-mix() color.
// A third, dimmer text level for ages, as the app sets its timestamps apart: one gray that keeps about
// 4.5:1 on the dark pane and 3.9:1 on the light one, since no theme key draws a dimmer text.
const DESKTOP_AGE = '#85837e'
const DESKTOP_PALETTE: Palette = {
  raised: 'rgba(128, 120, 105, 0.14)',
  raisedText: 'text',
  selection: 'rgba(128, 120, 105, 0.14)',
  muted: 'inactive',
  age: DESKTOP_AGE,
  key: 'remember',
  line: 'subtle',
  divider: 'rgba(128, 128, 128, 0.25)',
  // Text keeps the app's own color, except a failure, which reads in the app's red.
  tone: { error: 'error' },
  // Counts and kind marks keep their status colors, so a count or a finding's kind reads at a glance.
  // PRs take the app's blue, `suggestion`, so the PR count and each PR's number match.
  mark: { needsYou: NEEDS_YOU, issue: NEEDS_YOU, findings: FINDINGS, prs: 'suggestion', done: DONE, error: 'error' },
}
/**
 * The look the mod draws for an engine surface. Mobile and VS Code get the terminal look, which nobody has checked
 * there: docs/reference/claude-desktop-app.md records what is known about those surfaces.
 */
function lookOf(surface: RenderSurface): Look {
  return surface === 'desktop' ? 'desktop' : 'terminal'
}
/** The palette for a Claude Code theme in the terminal. The desktop app's palette follows the app instead. */
function paletteFor(theme: string, look: Look): Palette {
  return look === 'desktop' ? DESKTOP_PALETTE : (PALETTES[theme] ?? THEME_KEY_PALETTE)
}
// The blank columns on each side of a docked tab's name, which a click there also selects. A pane too narrow
// for the three tabs at this padding draws them with one column each side instead.
const TAB_PAD = '  '
// From this many columns, the inline terminal pane draws its tabs in a column at its left, apart from the rows.
const INLINE_RAIL_AT = 80
// The blank columns between the inline tab column and the rows beside it.
const RAIL_GUTTER = 2
// The Needs you tab lists questions first, because each takes one key.
const NEEDS_YOU_GROUPS: { kind: Item['kind']; title: string; list: 'questions' | 'tasks' }[] = [
  { kind: 'question', title: 'Questions', list: 'questions' },
  { kind: 'task', title: 'Tasks', list: 'tasks' },
]
// The lists with a Closed fold.
const FOLD_KINDS: FoldKind[] = [...NEEDS_YOU_GROUPS.map(g => g.kind), 'issue', 'opportunity']
const MODEL = 'sonnet'
const AWAY_MS = 15 * 60_000
const KEPT_SESSIONS = 40
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[\w.-]+\.localhost)(?::\d+)?[^\s"'`)\]]*/g

// One turn's exchange, gathered across hooks. Module variables reset on a hot
// reload, which only loses the turn in progress.
let activity: string[] = []
let person: string | null = null
let trigger: string | null = null
let isTurnRunning = false
let isOn = false
// The press behind this turn's prompt.
let press: Press | null = null
// Replies a Stop hook sent Claude back from this turn, before the final one.
let sentBack: string[] = []
// Set in session.start, which a hot reload runs again.
let sessionId = ''
let root = ''
// The PR fetches, one at a time, and the next one when it is waiting to start: whether it looks up the branch's PR.
let fetchingPrs: Promise<void> = Promise.resolve()
let nextFetchFindsBranchPr: boolean | null = null
// Each tab's row ids as of the last write that can add a row, so a row that appears later counts as new.
let recordedRows: { isDemo: boolean; ids: RowRecord<Tab> } | null = null
/** Whether the pane last drew inline, where the open row scrolls to the window's top so its keys stay in view. */
let isInlinePane = false
/** The inline pane's size at its last draw, as columns by rows, or null when it last drew docked. */
let inlineSize: string | null = null
let isSaved = false
let queue: Promise<void> = Promise.resolve()
// Counts the conversations this process has run, and the saved ledgers [Try again] put in place,
// so an update queued on one ledger never writes into the next.
let conversation = 0
// What Claude last read of the inbox beside a prompt, so it is sent again only when it changed.
let told: Told = TOLD_NOTHING
// The line last published to this pane's Herdr sidebar row, and the chain that publishes in order.
let published: string | null = null
let publishing: Promise<void> = Promise.resolve()
// Context for prompts this mod sent, by text, appended just before each prompt's row.
const contextFor = new Map<string, string[]>()
// A count of this mod's prompt rows stored, and its value at each text's latest row, so a
// send can tell whether its prompt entered while `$.prompt.submit` settled.
const storedAt = new Map<string, number>()
let storedCount = 0
// The `!` command whose output row comes next.
let shellCommand: string | null = null
// The engine refused a `$.tool.register` at turn-on, as an organization's settings can, so Claude cannot record or close items.
let toolsRefused = false
// Whether [Try again] is reading the saved session that UNREADABLE names.
let isReadingAgain = false
/**
 * The desktop app takes the focus off the pane when the Button holding it leaves the drawing, and
 * the next click there only brings it back (anthropics/claude-code#100874). The pane tracks the key
 * that holds the focus: the Button a press focused, or the text field the pane moved it to. It moves
 * the focus when a drawing leaves that key out, or first draws the field a Type press opened.
 */
let focusedKey: string | null = null
/**
 * The key that takes the pressed Button's place, such as a closed row's Undo, tried first. A Type
 * press names its text field, which takes the focus once a drawing has it, though the Button stays.
 */
let focusHint: string | null = null
/** The pressed key's `focusHint`. */
function focusHintFor(element: string): string | null {
  const id = element.split('-')[1]

  return /^(answer|done|dismiss|drop)-/.test(element)
    ? `undo-${id}`
    : element.startsWith('typekey-')
      ? `type-${id}`
      : null
}
/**
 * The desktop follow-ups' presses by key, from the latest drawing. Their Client posts the clicked key,
 * which runs the press its Button would have.
 */
const followUpPresses = new Map<string, (press: UiPressArgument) => void>()
/** Which look the pane last drew in, for the redraws a timer runs. */
let paneLook: Look = 'terminal'

/** Every Button and Input key in a drawn tree: the keys the focus can move to. */
function focusKeys(node: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const child of node) focusKeys(child, keys)
  else if (node && typeof node === 'object') {
    const el = node as { type?: unknown; props?: { key?: unknown }; children?: unknown }
    if ((el.type === 'Button' || el.type === 'Input') && typeof el.props?.key === 'string') keys.add(el.props.key)
    focusKeys(el.children, keys)
  }

  return keys
}

// What [Resume] on a stop did: sending its prompt, or why the prompt will not enter.
let resuming: { is: 'sending' } | { is: 'refused'; why: string } | null = null
// The draft a row's field opened with. The engine replaces the typed text whenever the drawn
// `value` changes, so drawing each saved keystroke as `value` can drop keys typed before it lands.
const fieldSeeds = new Map<string, string>()

/** Clears everything gathered for the turn's exchange. */
function resetTurn() {
  activity = []
  person = null
  trigger = null
  press = null
  sentBack = []
}

/** Adds a message or a command of the person's to what they sent this turn. */
function notePerson(line: string) {
  person = person === null ? line : `${person}\n\n${line}`
}

function noteActivity(line: string) {
  if (activity.length < 40 && !activity.includes(line)) activity.push(line)
}

/** A transcript row's text, its text blocks joined. */
function messageText(message: SessionAppendMessage): string {
  return message.content.map(b => (b.type === 'text' ? b.text : '')).join('')
}

/** A tool result's fields, or none when the result is not an object. */
function resultFields(ran: { result?: unknown }): Record<string, unknown> {
  return ran.result && typeof ran.result === 'object' ? (ran.result as Record<string, unknown>) : {}
}

/** Reads which Claude Code theme draws the pane. */
async function syncTheme($: EngineInterface) {
  const theme = (await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value
  await update($, THEME, () => (typeof theme === 'string' ? theme : ''))
}

async function save($: EngineInterface, ledger: Ledger) {
  // Until a read succeeds, the saved copy holds the conversation's rows, and this ledger lacks them.
  if ((await read($, UNREADABLE)) === sessionId) return
  const savedAt = await $.clock.now()
  const key = `s:${sessionId}`
  // The first save in a process deletes the key first, moving it to the end of
  // the store's insertion order, which the pruning treats as most recent. Later
  // saves only overwrite, so pruning runs once per process.
  if (!isSaved) await $.store.delete(key)
  await $.store.set(key, { savedAt, ledger })
  if (isSaved) return
  isSaved = true
  const keys = await $.store.keys()
  const sessions = keys.filter(k => k.startsWith('s:'))
  // `p:` keys held the last-session offer, which earlier builds saved per folder.
  const stale = [
    ...sessions.slice(0, Math.max(0, sessions.length - KEPT_SESSIONS)),
    ...keys.filter(k => k.startsWith('p:')),
  ]
  await Promise.all(stale.map(old => $.store.delete(old)))
}

/**
 * Publishes the session's status line to its Herdr pane, where a sidebar row
 * showing the `inbox` token reads it. Outside Herdr it does nothing. Calls run
 * in order and read the state when they run, so an older line never lands
 * after a newer one, as when a dialog opens and closes in quick succession.
 */
function publishStatus($: EngineInterface, isEnding = false): Promise<void> {
  publishing = publishing
    .then(async () => {
      const pane = await $.env.get('HERDR_PANE_ID')
      if (!pane) return
      const [ledger, stop, dialogs, lastActions, presence, now] = await Promise.all([
        read($, LEDGER),
        read($, STOP),
        read($, DIALOGS),
        read($, LAST_ACTIONS),
        read($, PRESENCE),
        $.clock.now(),
      ])
      // Only the items and findings the band counts, in the pane's order: a row handed to Claude waits on no one.
      const { needsYou, findings } = viewOf({ ledger, lastActions, notes: {}, turns: presence, now }, presence)
      const items = [...needsYou.questions, ...needsYou.tasks]
        .filter(r => r.state.is === 'open')
        .flatMap(r => (r.item ? [r.item] : []))
      const open = findings.rows.filter(r => r.state.is === 'open').flatMap(r => (r.finding ? [r.finding] : []))
      const line = isEnding ? '' : statusLine({ ...ledger, items, findings: open }, stop, dialogs)
      if (line === published) return
      published = line
      const token = line ? ['--token', `inbox=${line}`] : ['--clear-token', 'inbox']
      await $.process.run(['herdr', 'pane', 'report-metadata', pane, '--source', 'inbox', ...token], {
        timeoutMs: 5000,
      })
    })
    .catch(() => undefined)

  return publishing
}

async function setStop($: EngineInterface, stop: Stop | null) {
  if (stop === null && (await read($, STOP)) === null) return
  resuming = null
  await update($, STOP, () => stop)
  void publishStatus($)
}

/** [Resume] on a stop sends what the person would type. The turn's start clears the stop. */
async function resume($: EngineInterface) {
  // [Resume] keeps its key while it reads "Resuming…", so a second press lands here.
  if (resuming?.is === 'sending') return
  // The band and the pane both read the stop, so writing it again redraws both.
  const redraw = () => update($, STOP, s => (s ? { ...s } : s))
  resuming = { is: 'sending' }
  await redraw()
  const sent = await send($, 'Continue')
  if ('notSent' in sent) {
    resuming = { is: 'refused', why: sent.notSent }
    await redraw()
  }
}

/**
 * A tool call's identity: the tool and its main argument. A dialog keeps it,
 * so it closes when its own call ends, not when a like call does.
 */
function callKey(tool: string, input: Record<string, unknown>): string {
  const main = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query', 'skill', 'description'].find(
    k => typeof input[k] === 'string',
  )

  return main ? `${tool} ${main}=${String(input[main])}` : `${tool} ${JSON.stringify(input)}`
}

async function openDialog($: EngineInterface, dialog: Dialog) {
  await update($, DIALOGS, d => [...d.filter(x => x.key !== dialog.key), dialog])
  void publishStatus($)
}

/** Closes the dialogs of one call, or every dialog. */
async function closeDialogs($: EngineInterface, key: string | null) {
  if (!(await read($, DIALOGS)).some(d => key === null || d.key === key)) return
  await update($, DIALOGS, d => (key === null ? [] : d.filter(x => x.key !== key)))
  void publishStatus($)
}

/** Runs a tool call and closes its dialog when the call resolves, since `next` returns only after the person answers any prompt for it. */
async function clearingDialog<T>($: EngineInterface, key: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } finally {
    await closeDialogs($, key)
  }
}

/** What a permission prompt asks, in a few words: "push main to origin", "edit README.md". */
function permissionText(tool: string, input: Record<string, unknown>): string {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const file = (key: string) => baseName(text(key))
  switch (tool) {
    case 'Bash': {
      const said = text('description') || text('command')
      // "Push main to origin" reads as "Allow push main to origin?"; an acronym keeps its case.
      return clipLabel(/^[A-Z][a-z]/.test(said) ? said.charAt(0).toLowerCase() + said.slice(1) : said, 60)
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `edit ${file('file_path')}`
    case 'NotebookEdit':
      return `edit ${file('notebook_path')}`
    case 'Read':
      return `read ${file('file_path')}`
    case 'Glob':
    case 'Grep':
      return `search ${text('path') ? `${file('path')} ` : ''}for ${clipLabel(text('pattern'), 30)}`
    case 'WebFetch':
      return `fetch ${
        text('url')
          .replace(/^https?:\/\//, '')
          .split('/')[0]
      }`
    case 'WebSearch':
      return `search the web for ${clipLabel(text('query'), 30)}`
    case 'Skill':
      return `use the ${text('skill')} skill`
    case 'Agent':
    case 'Task':
      return text('description') ? `run an agent: ${text('description')}` : 'run an agent'
    default:
      return tool.startsWith('mcp__') ? tool.slice(5).replace(/__/g, ' ') : tool
  }
}

/** Changes the ledger and saves it, so a resumed session finds it. */
async function commitLedger($: EngineInterface, change: (l: Ledger) => Ledger): Promise<void> {
  let before: Ledger = EMPTY
  const after = await update($, LEDGER, l => {
    // A tool call can land after a hot reload and before turnOn converts the ledger an older build saved.
    before = upgradeLedger(l)
    return change(before)
  })
  await save($, after)
  void publishStatus($)
  // A row this change closed stays in place, with its leave bar, for SETTLED_MS.
  if (hasNewClose(before, after)) redrawWhileLeaving($, SETTLED_MS)
  void followNewRows($).catch(() => undefined)
}

/** Whether `after` closed an item or finding that `before` had not. */
function hasNewClose(before: Ledger, after: Ledger): boolean {
  const closes = (l: Ledger) => [
    ...l.closed.map(d => `${d.id} ${d.at}`),
    ...l.closedFindings.map(f => `${f.id} ${f.closedAt}`),
  ]
  const was = new Set(closes(before))

  return closes(after).some(c => !was.has(c))
}

/**
 * The inbox view of a ledger, with the item status the presence gives. With
 * `prViews`, an item whose ask names a tracked PR gets a step that opens it;
 * the counts need none.
 */
function viewOf(
  {
    ledger,
    lastActions,
    notes,
    turns,
    prViews,
    now,
  }: Pick<DemoCopy, 'ledger' | 'lastActions' | 'turns'> & {
    notes: Record<string, RowNote>
    prViews?: PrViews
    now: number
  },
  presence: Presence,
): InboxView {
  return inboxView({
    ledger,
    lastActions,
    notes,
    turns,
    now,
    extraSteps: prViews ? Object.fromEntries(ledger.items.map(i => [i.id, itemPrSteps(i, prViews, ledger.prs)])) : {},
    settleWindowMs: SETTLED_MS,
    // catchUp reruns a failed update after the next message.
    status: perTurnStatus({
      isUpdating: presence.isUpdating,
      isFailed: presence.ledgerState === 'failed',
      retries: true,
    }),
  })
}

/**
 * Redraws the pane at each step of a settled row's leave bar, for `waitMs`,
 * so the row leaves once SETTLED_MS after its close has passed. The view reads
 * the time, so a fresh value of what it draws from is what redraws it: the
 * session's last actions, or the demo's copy.
 */
function redrawWhileLeaving($: EngineInterface, waitMs: number) {
  // Whole milliseconds, so the last wait ends at `waitMs` and its redraw finds the row gone.
  // Desktop draws no leave bar and redraws once, when the row leaves: while the bar redrew every
  // 213 ms there, clicks on the pane's Buttons, Undo among them, did nothing.
  const step = paneLook === 'desktop' ? waitMs : Math.ceil(SETTLED_MS / LEAVE_BAR_STEPS)
  void (async () => {
    for (let left = waitMs; left > 0; left -= step) {
      await $.clock.sleep(Math.min(step, left))
      await Promise.all([update($, LAST_ACTIONS, a => ({ ...a })), update($, DEMO, d => d && { ...d })])
    }
    await openLeftRows($)
  })().catch(() => undefined)
}

/** Runs `run` after `waitMs`, dropping a failure. */
function later($: EngineInterface, waitMs: number, run: () => unknown) {
  void (async () => {
    await $.clock.sleep(waitMs)
    await run()
  })().catch(() => undefined)
}

/**
 * A reload cancels the redraws that were running, so this sets them again
 * until the latest of these ends, each SETTLED_MS after its time: a close, a
 * PR's Dismiss, a finding's Fix, a Local result and a row's note. Drawn on the demo's copy
 * while the demo shows.
 */
async function redrawAfterReload($: EngineInterface) {
  const { ledger, lastActions, notes, now } = await drawnState($)
  const times = [
    ...ledger.closed.map(d => d.at),
    ...ledger.closedFindings.map(f => f.closedAt),
    ...Object.values(lastActions).flatMap(a => [
      ...(a.result ? [a.result.at] : []),
      ...(a.action === 'pr-dismiss' || a.action === 'address' ? [a.at] : []),
    ]),
    ...Object.values(notes).map(n => n.at),
  ]
  const waitMs = Math.max(0, ...times.map(t => t + SETTLED_MS - now))
  if (waitMs > 0) redrawWhileLeaving($, waitMs)
}

type ModelResult = Awaited<ReturnType<EngineInterface['model']['fork']>>

type LedgerState = Presence['ledgerState']

/** Applies the ledger model's reply. */
async function applyLedgerReply(
  $: EngineInterface,
  at: number,
  r: ModelResult,
  source: string | null,
  change: (l: Ledger, u: Update, now: number) => Ledger,
): Promise<LedgerState> {
  if (!r.isAnswered) {
    // A fork has nothing to read until this process sends its first request,
    // as after a resume. The catch-up runs again after the next reply.
    return r.reason === 'nothing-to-fork' ? 'behind' : 'failed'
  }
  const parsed = parseReply(r.text, source)
  if (!parsed || at !== conversation) return 'failed'
  const now = await $.clock.now()
  await commitLedger($, l => change(l, parsed, now))

  return 'current'
}

/** Asks the ledger model to update the ledger, with systemText as its instructions, cached for the next call within five minutes. */
function askLedgerModel($: EngineInterface, prompt: string, timeoutMs: number): Promise<ModelResult> {
  const system = [{ text: systemText(CLAUDE_CODE), cache: true as const }]

  return $.model.complete({ model: MODEL, system, prompt, maxTokens: 1600, effort: 'low', timeoutMs })
}

/** Updates the ledger from one exchange. */
async function runUpdate($: EngineInterface, at: number, ex: Exchange): Promise<LedgerState> {
  const promptAt = await $.clock.now()
  const r = await askLedgerModel($, buildPrompt(await read($, LEDGER), ex), 45_000)
  // An Explain turn talks about its item without deciding it.
  const explained = ex.press?.action === 'explain' ? ex.press.id : null

  return applyLedgerReply($, at, r, [ex.reply, ...ex.activity].join('\n'), (l, u, now) =>
    applyUpdate(l, { ...u, closed: u.closed.filter(c => c.id !== explained) }, now, ex.turn, promptAt),
  )
}

/**
 * Brings the ledger up to date over the whole conversation, for turns the
 * per-turn update missed: it closes what was handled and adds what still waits.
 */
async function catchUp($: EngineInterface, at: number): Promise<LedgerState> {
  const [ledger, shown] = await Promise.all([read($, LEDGER), screen($)])
  const change = (l: Ledger, u: Update, now: number) => applyUpdate(l, u, now, l.turn)
  const forked = await $.model.fork({ prompt: catchUpPrompt(CLAUDE_CODE, ledger, shown) })
  if (forked.isAnswered || forked.reason !== 'nothing-to-fork') return applyLedgerReply($, at, forked, null, change)
  // A resumed conversation has no request of this process's to fork until its
  // first reply, so the model reads the transcript instead, uncached.
  const transcript = transcriptText(await $.session.messages())
  if (!transcript) return 'behind'
  const r = await askLedgerModel($, transcriptCatchUpPrompt(ledger, shown, transcript), 90_000)

  return applyLedgerReply($, at, r, transcript, change)
}

/**
 * Queues the next update: a catch-up while the ledger may have missed a turn,
 * else this exchange alone.
 */
function queueUpdate($: EngineInterface, next: { ex: Exchange; turnsStarted: number } | null) {
  const at = conversation
  queue = queue.then(async () => {
    if (at !== conversation) return
    const { ledgerState, turnsStarted } = await update($, PRESENCE, p => ({ ...p, isUpdating: true }))
    const state = await (ledgerState !== 'current' || next === null ? catchUp($, at) : runUpdate($, at, next.ex)).catch(
      (): LedgerState => 'failed',
    )
    if (at !== conversation) return
    // An exchange covers the turns started by its end; a catch-up, those started before it ran. A failed update
    // counts too: the reply has ended, so a row waiting on it stops reading "Explaining…". The
    // failed state still runs a catch-up.
    const applied = next?.turnsStarted ?? turnsStarted
    await update($, PRESENCE, p => ({
      ...p,
      ledgerState: state,
      isUpdating: false,
      turnsApplied: Math.max(p.turnsApplied, applied),
    }))
    // A row waiting on Claude's reply counts again, or reads its ✓, once the update for its turn applies.
    void publishStatus($)
  })
  // A rejected link would skip every later update, so the chain swallows it.
  queue = queue.catch(() => undefined)
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const p = await read($, PRESENCE)
  if (p.isAway) {
    await update($, PRESENCE, q => ({ ...q, minute: Math.floor(now / 60_000) }))
  } else if (!isTurnRunning && p.lastActiveAt > 0 && now - p.lastActiveAt > AWAY_MS) {
    await update($, PRESENCE, q => ({ ...q, isAway: true, minute: Math.floor(now / 60_000) }))
  }
}

/**
 * Sends a prompt as the person's own message. A plugin's own prompt skips that
 * plugin's prompt.submit hook, so the bookkeeping happens here, and what
 * Claude reads beside the prompt goes just before it, in a row only the model sees.
 * Resolves once the prompt entered or was queued, or with why it will not enter.
 * A prompt that will not enter is taken back out of what Claude and the per-turn
 * update read next; the prompt count stays.
 */
async function send($: EngineInterface, text: string, sentBy: Press | null = null): Promise<Sent> {
  const [toldBefore, pressBefore] = [told, press]
  const context = await notePrompt($, text, sentBy)
  const toldSent = told
  // The engine may run the prompt now, after the running turn, or inside it, so
  // the context goes in when the prompt's own row is stored (session.append).
  if (context.length > 0) contextFor.set(text, context)
  const since = storedCount
  const sent = await $.prompt.submit({ text, asUser: true }).then(
    (r): Sent => (r.drop === undefined ? { entered: r.text, since } : { notSent: r.drop }),
    // A rejection after the prompt's row was stored still reached Claude.
    (err: unknown): Sent =>
      isStoredSince(text, since)
        ? { entered: text, since }
        : { notSent: (err instanceof Error ? err.message : String(err)) || 'the session refused it' },
  )
  if ('entered' in sent) {
    // Another plugin's prompt.submit hook rewrote the prompt, so its context waits under the text that enters.
    if (sent.entered !== text && contextFor.get(text) === context) {
      contextFor.delete(text)
      if (!isStoredSince(sent.entered, since)) contextFor.set(sent.entered, context)
    }

    return sent
  }
  // Each part is put back only while nothing since has changed it.
  if (told === toldSent) told = toldBefore
  if (person === text) person = null
  else if (person?.endsWith(`\n\n${text}`)) person = person.slice(0, -(text.length + 2))
  if (sentBy && press === sentBy) press = pressBefore
  if (contextFor.get(text) === context) contextFor.delete(text)

  return sent
}

/**
 * How a send ended: the text that entered, which another plugin's prompt.submit
 * hook may have rewritten, with the stored-row count before the send; or why it will not enter.
 */
type Sent = { entered: string; since: number } | { notSent: string }

/** Whether a row of this mod's with `text` was stored after the stored-row count was `since`. */
function isStoredSince(text: string, since: number): boolean {
  return (storedAt.get(text) ?? 0) > since
}

/** Appends context as a row only the model reads. Without it Claude still gets the prompt, so a refused append is ignored. */
async function appendContext($: EngineInterface, context: string[]) {
  const content = [{ type: 'text' as const, text: context.join('\n\n') }]
  await $.session.append({ message: { type: 'user', content } }).catch(() => undefined)
}

/**
 * Records a prompt in the person's words and returns what Claude reads beside
 * it: the questions a numbered answer refers to, and the inbox when it changed.
 */
async function notePrompt($: EngineInterface, text: string, sentBy: Press | null): Promise<string[]> {
  const [now, ledger, isShown] = await Promise.all([
    $.clock.now(),
    update($, LEDGER, l => ({ ...l, turn: l.turn + 1 })),
    isPaneShown($),
  ])
  await update($, PRESENCE, p => ({ ...p, lastActiveAt: now, isAway: false }))
  const r = promptNotes(CLAUDE_CODE, ledger, { text, isPress: sentBy !== null, isOpen: isShown }, told)
  const notes = r.notes
  told = r.told

  if (sentBy) press = sentBy
  notePerson(text)
  trigger = null

  return notes
}

/** Opens a path an item names, as `openCommands` decides. Returns why it could not, or null. */
async function openPath($: EngineInterface, raw: string): Promise<string | null> {
  const path = localPath(raw, root, (await $.env.get('HOME')) ?? '')
  if (!(await $.fs.exists(path))) return 'it no longer exists'
  const stat = await $.fs.stat(path)
  const isFile = stat.kind === 'file'
  const isExecutable = isFile && (await $.process.run(['test', '-x', path])).exitCode === 0
  const { argv, fallback } = openCommands(path, isFile, isExecutable)
  const r = await $.process.run(argv)
  const retry = r.exitCode !== 0 && fallback ? await $.process.run(fallback) : r

  return retry.exitCode === 0 ? null : retry.stderr.trim() || `open exited ${retry.exitCode}`
}

/**
 * Brings state an earlier version of the mod wrote up to date, and returns the
 * ledger. A reload keeps $.state, so a running session can still hold findings
 * under `notes`, and `notes` as its tab, and the Needs you tab as `waiting`,
 * with item kinds `decide` and `do`, PR threads without a time or
 * `isLinesChanged`, and last actions saved by button key without a kind.
 */
async function upgradeState($: EngineInterface): Promise<Ledger> {
  const [ledger] = await Promise.all([
    update($, LEDGER, upgradeLedger),
    update($, TAB, t => ((t as string) === 'notes' ? 'findings' : (t as string) === 'waiting' ? 'needsYou' : t)),
    update($, SELECTION, ({ waiting, ...s }: Record<Tab, Cursor> & { waiting?: Cursor }) => {
      const cursors: Record<Tab, Cursor> = { ...NO_SELECTION, ...(waiting ? { needsYou: waiting } : {}), ...s }
      // A cursor saved before `openedAt` existed: no click opened its row in a way that still guards it.
      return Object.fromEntries(
        Object.entries(cursors).map(([t, c]) => [t, { ...c, openedAt: c.openedAt ?? 0 }]),
      ) as Record<Tab, Cursor>
    }),
    // Old builds saved the group kinds as `decide` and `do`, and Findings' one fold as `finding`, now one per kind.
    update($, UNFOLDED, u =>
      u.flatMap((k: string): FoldKind[] =>
        k === 'finding' ? ['issue', 'opportunity'] : k === 'issue' || k === 'opportunity' ? [k] : [readKind(k)],
      ),
    ),
    // A demo an earlier build seeded may lack a field this one draws, so it ends; /inbox demo seeds a new one.
    update($, DEMO, d => (d === null || isDemoCopy(d) ? d : null)),
    // Last actions an earlier build saved by button key, without a kind. Those for Open, Open log,
    // a session check and a PR check's Fix record nothing now, so they go.
    update($, LAST_ACTIONS, upgradeLastActions),
    // Presence from before the turn counts existed cannot say whether the last
    // turn's update landed, so that load catches up once.
    update($, PRESENCE, p => ({ ...p, turnsStarted: p.turnsStarted ?? 1, turnsApplied: p.turnsApplied ?? 0 })),
    update($, PR_VIEWS, v => ({
      ...v,
      views: Object.fromEntries(
        Object.entries(v.views).map(([ref, pr]) => [
          ref,
          {
            ...pr,
            threads: pr.threads.map(t => ({
              ...t,
              isLinesChanged: t.isLinesChanged ?? false,
              at: t.at ?? null,
              reply: t.reply && { ...t.reply, at: t.reply.at ?? null },
            })),
          },
        ]),
      ),
    })),
  ])

  return ledger
}

/** Runs a record_finding or close call on the ledger. Returns the text the agent reads back. */
async function runTool(
  $: EngineInterface,
  tool: typeof recordFinding,
  input: Record<string, unknown>,
): Promise<string> {
  const now = await $.clock.now()
  let result = ''
  await commitLedger($, l => {
    const r = tool(CLAUDE_CODE, l, input, now)
    result = r.result
    return r.ledger
  })

  return result
}

/**
 * Opens the pane, or raises it, asking for the keyboard. The surface grants
 * that only while the prompt holds the keys over an empty composer.
 */
function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Inbox', focus: true, closeOnEscape: true })
}

/**
 * Opens the shown tab's first waiting row, as the pane opens. With none, the
 * tab draws its first waiting row open by default once one arrives.
 */
async function openTopRow($: EngineInterface) {
  const [{ view, ledger, prViews: prState, lastActions, now }, tab] = await Promise.all([drawnState($), read($, TAB)])
  const prViews = drawnPrs(prState, ledger.prs, lastActions, now)
    .filter(x => !x.isSettled)
    .map(x => x.pr)
  const ids = tabRowIds(view, prViews)[tab]
  const top = firstWaiting(tabWaits(tab, view, prViews, lastActions))
  if (top === null) await update($, SELECTION, s => ({ ...s, [tab]: NO_CURSOR }))
  else await select($, tab, top, ids.indexOf(top))
}

/** Opens the pane on the shown tab with its top row open, as /inbox does. Nothing in the tabs counts as new. */
async function showInbox($: EngineInterface) {
  await openPane($)
  await followNewRows($, true)
  await openTopRow($)
}

/**
 * The band's [Open inbox]: opens the pane with the top row that needs the
 * person open, the row line 1 names. With none, it opens on the shown tab.
 */
async function openInbox($: EngineInterface) {
  // Opened before any other await. After one, the engine no longer counts the press as
  // asking for the pane, and below 144 columns, once the person has closed it, leaves it unplaced.
  await openPane($)
  const { view } = await drawnState($)
  if (view.needsYou.count > 0) await update($, TAB, () => 'needsYou' as const)
  else if ((await read($, TAB)) === 'prs') await findPrs($)
  await followNewRows($, true)
  await openTopRow($)
}

/** Sends a row's draft as its typed answer or reply, as Enter in its field does. */
async function sendDraft($: EngineInterface, id: string, surface: UiPressArgument['surface']) {
  await sendTyped($, id, (await read($, DRAFTS))[id] ?? '', surface)
}

/** Sends typed words as a row's answer or reply. Blank ones send nothing and leave the field open with the keyboard. */
async function sendTyped($: EngineInterface, id: string, text: string, surface: UiPressArgument['surface']) {
  if (text.trim()) await runPress($, { action: 'type', id, text }, surface)
  else await focusField($, id)
}

/** Opens the free-text field under a row and gives it the keyboard. */
async function startTyping($: EngineInterface, id: string) {
  fieldSeeds.set(id, (await read($, DRAFTS))[id] ?? '')
  await keepPressedOpen($, id)
  await update($, TYPING, () => id)
  await focusField($, id)
}

/** Gives a row's open text field the keyboard. */
async function focusField($: EngineInterface, id: string) {
  // A click leaves the keys with the prompt, and `ui.focus` is refused in a pane that lacks them.
  await openPane($)
  await $.ui.focus({ requestId: PANE, key: `type-${id}` }).catch(() => undefined)
}

async function showTab($: EngineInterface, tab: Tab) {
  if (tab === 'prs') await findPrs($)
  await update($, TAB, () => tab)
  await scrollToOpenRow($, tab)
}

/**
 * Refreshes the PRs tab as it comes into view, asking gh for the branch's PR.
 * Call it before the tab draws: it marks the fetch first, so the tab opens on
 * "Checking for PRs…" and not on "No PRs". The demo shows sample PRs, so it asks nothing.
 */
async function findPrs($: EngineInterface) {
  if (await read($, DEMO)) return
  await update($, PR_VIEWS, v => ({ ...v, isFetching: true }))
  void fetchPrs($, true)
}

/** How many lines `text` takes when wrapped at word breaks to `width` cells. */
function lineCount(text: string, width: number): number {
  return wrapped(text, width).length
}

/** `text` cut to its first `lines` lines at `width` cells, ending in "…" when cut. */
function clipToLines(text: string, width: number, lines: number): string {
  const all = wrapped(text, width)
  if (all.length <= lines) return text
  const last = all[lines - 1]!
  const kept = [...all.slice(0, lines - 1), last.length < width ? last : last.slice(0, width - 1)]

  return `${kept.join(' ').replace(/[\s.,;:]+$/, '')}…`
}

/** `text` wrapped at word breaks to `width` cells, as the terminal wraps a Text; a longer word breaks anywhere. */
function wrapped(text: string, width: number): string[] {
  const size = Math.max(1, width)
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= size) {
      line = next
      continue
    }
    if (line) lines.push(line)
    let rest = word
    while (rest.length > size) {
      lines.push(rest.slice(0, size))
      rest = rest.slice(size)
    }
    line = rest
  }
  if (line) lines.push(line)

  return lines
}

/**
 * Selects a row and scrolls the pane the least that shows it whole. The row's
 * scroll target is drawn only once the row redraws expanded, and the engine
 * refuses a key it has not drawn, so the scroll retries for a few frames.
 * Measured before the redraw, the row's end would land out of view.
 */
async function select($: EngineInterface, tab: Tab, id: string, index: number) {
  const openedAt = await $.clock.now()
  await update($, SELECTION, s => ({ ...s, [tab]: { id, index, openedAt } }))
  await update($, TYPING, t => (t === id ? t : null))
  // The row's buttons draw dim while guarded. A render cannot write state, so a fresh value redraws them once the guard ends.
  later($, PRESS_GUARD_MS, () => update($, SELECTION, s => ({ ...s })))
  await scrollToRow($, id)
}

/**
 * Scrolls the pane to row `id`: inline to the window's top, else the least that shows it whole. The row's scroll
 * target is drawn only once the row redraws expanded, and the engine refuses a key it has not drawn, so the scroll
 * retries for a few frames.
 */
async function scrollToRow($: EngineInterface, id: string) {
  for (let tries = 0; tries < 10; tries++) {
    const block = isInlinePane ? 'start' : 'nearest'
    const result = await $.ui.scroll({ in: PANE, to: { key: `view-${id}` }, block }).catch((): UiScrollResult => ({}))
    if (result.deny === undefined) return
    await $.clock.sleep(30)
  }
}

/** Scrolls the pane to the shown tab's open row when the pane is inline, else to its top. */
async function scrollToOpenRow($: EngineInterface, tab: Tab) {
  if (isInlinePane) {
    const [selection, { view, ledger, prViews: prState, lastActions, now }] = await Promise.all([
      read($, SELECTION),
      drawnState($),
    ])
    const prViews = drawnPrs(prState, ledger.prs, lastActions, now)
      .filter(x => !x.isSettled)
      .map(x => x.pr)
    const cursor = selection[tab]
    const id = cursor.id ?? (cursor.openedAt === 0 ? firstWaiting(tabWaits(tab, view, prViews, lastActions)) : null)
    if (id !== null) return scrollToRow($, id)
  }
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
}

/**
 * Opens the row whose desktop Client took a click, if the shown tab still lists it. A click less
 * than PRESS_GUARD_MS after a row opened does nothing: the list reflows under the pointer as a row
 * opens, so a quick second click lands on another row.
 */
async function selectClicked($: EngineInterface, id: string) {
  const [{ ledger, prViews: prState, lastActions, view, now }, tab, selection] = await Promise.all([
    drawnState($),
    read($, TAB),
    read($, SELECTION),
  ])
  const prViews = drawnPrs(prState, ledger.prs, lastActions, now)
    .filter(x => !x.isSettled)
    .map(x => x.pr)
  const index = tabRowIds(view, prViews)[tab].indexOf(id)
  if (index < 0 || isGuarded(selection[tab].openedAt, now)) return
  // The Client leaves the drawing as its row opens, so the focus repair moves the focus to the row's first action.
  focusedKey = `select-${id}`
  focusHint = null
  await select($, tab, id, index)
}

/**
 * Sets a list's Closed fold to the state its desktop Client posted. A set, not a toggle: a second
 * click before the redraw posts the same state, so a double-click leaves the fold unfolded.
 */
async function setFold($: EngineInterface, kind: string, isUnfolded: unknown) {
  const fold = FOLD_KINDS.find(k => k === kind)
  if (fold === undefined || typeof isUnfolded !== 'boolean') return
  await update($, UNFOLDED, u =>
    u.includes(fold) === isUnfolded ? u : isUnfolded ? [...u, fold] : u.filter(k => k !== fold),
  )
}

/** Records which Closed fold is under the pointer, so its chevron draws in the label's hover color. */
async function setFoldHover($: EngineInterface, kind: string, isHover: boolean) {
  const fold = FOLD_KINDS.find(k => k === kind)
  if (fold === undefined) return
  await update($, FOLD_HOVER, h => (isHover ? fold : h === fold ? null : h))
}

/**
 * The open row's position, or -1 when none is open. A tab with no row opened in
 * this conversation draws `top` open. While the open row shows as just closed,
 * none is open. Once it leaves, the row now in its place opens, and
 * `openLeftRows` then guards that row's buttons as a click would.
 */
function selectedIndex(ids: string[], cursor: Cursor, top: string | null, isSettled: (id: string) => boolean): number {
  if (cursor.id !== null) {
    const at = ids.indexOf(cursor.id)
    if (at >= 0 || isSettled(cursor.id)) return at
    return ids.length === 0 ? -1 : Math.min(cursor.index, ids.length - 1)
  }

  return cursor.openedAt === 0 && top !== null ? ids.indexOf(top) : -1
}

/**
 * Moves each tab's cursor off a row that has left to the row now in its place, opened now, so its buttons ignore
 * clicks for PRESS_GUARD_MS as a row a click opened does. The redraw that removes a row calls this.
 */
async function openLeftRows($: EngineInterface) {
  const { ledger, prViews: prState, lastActions, view, now } = await drawnState($)
  const prViews = drawnPrs(prState, ledger.prs, lastActions, now)
    .filter(x => !x.isSettled)
    .map(x => x.pr)
  const ids = tabRowIds(view, prViews)
  const settled = new Set(settledRowIds(allRows(view)))
  let isMoved = false
  await update($, SELECTION, s => {
    const moved = Object.fromEntries(
      (Object.keys(s) as Tab[]).map(t => {
        const c = s[t]
        const list = ids[t]
        if (c.id === null || list.includes(c.id) || settled.has(c.id)) return [t, c]
        isMoved = true
        const index = Math.min(c.index, list.length - 1)
        return [t, index < 0 ? NO_CURSOR : { id: list[index]!, index, openedAt: now }]
      }),
    ) as Record<Tab, Cursor>
    return isMoved ? moved : s
  })
  // The opened row's buttons draw dim while guarded; a fresh value redraws them once the guard ends.
  if (isMoved) later($, PRESS_GUARD_MS, () => update($, SELECTION, s => ({ ...s })))
}

/** The shown tab's rows in drawn order, and whether each still waits on the person. */
function tabWaits(tab: Tab, view: InboxView, prViews: PrView[], lastActions: Record<string, LastAction>): RowWait[] {
  return tab === 'prs' ? prRowWaits(prViews, lastActions) : listWaits(view)[tab]
}

/**
 * Runs a click on one of row `rowId`'s buttons, unless that row opened less
 * than PRESS_GUARD_MS ago: then it is the second click of a double-click that
 * opened the row, landing on a button that just drew.
 */
async function unlessGuarded($: EngineInterface, rowId: string, press: UiPressArgument, onPress: Action['onPress']) {
  const [selection, tab, now] = await Promise.all([read($, SELECTION), read($, TAB), $.clock.now()])
  const cursor = selection[tab]
  if (cursor.id !== rowId || !isGuarded(cursor.openedAt, now)) await onPress(press)
}

/**
 * Keeps a row open once it is pressed while its tab draws it open by default,
 * so the default does not open another row when this one leaves or stops
 * counting. `openedAt` stays 0: the row was already open, so it is not guarded.
 */
async function keepPressedOpen($: EngineInterface, id: string) {
  const tab = await read($, TAB)
  await update($, SELECTION, s =>
    s[tab].id === null && s[tab].openedAt === 0 ? { ...s, [tab]: { id, index: 0, openedAt: 0 } } : s,
  )
}

/**
 * Records each tab's row ids by `recordRows` and returns, by tab, the ids it did not have at the last record.
 * The first record after the demo turns on or off starts afresh, so it returns nothing.
 */
function newRows(isDemo: boolean, current: Record<Tab, string[] | null>): Record<Tab, string[]> {
  const { seen, added } = recordRows(recordedRows?.isDemo === isDemo ? recordedRows.ids : {}, current)
  recordedRows = { isDemo, ids: seen }

  return added
}

/** Moves the pane to a tab and opens a row there, or shows the tab's top when there is none. */
async function jumpTo($: EngineInterface, tab: Tab) {
  await update($, TAB, () => tab)
  // With no row chosen, the tab draws its top row open, so rows that arrive above later move the open row with them.
  await update($, SELECTION, s => ({ ...s, [tab]: NO_CURSOR }))
  await scrollToOpenRow($, tab)
}

/** Each tab's selectable row ids, in the order the pane lists them: rows that just closed are left out. */
function tabRowIds(view: InboxView, prViews: PrView[]): Record<Tab, string[]> {
  const listed = drawnLists(
    view,
    () => false,
    r => r.id,
  ).byTab

  return { ...listed, prs: prRowWaits(prViews, {}).map(r => r.id) }
}

/**
 * Records the rows that just appeared, keeps open the row a tab drew open when
 * they arrive above it, and moves the pane to a new row on another tab while the
 * tab on screen shows only its empty text. `isOpening` records the tabs afresh,
 * so nothing in them counts as new. The render cannot write state, so each write
 * that can add a row calls this.
 */
async function followNewRows($: EngineInterface, isOpening = false) {
  const [drawn, tab, unfolded, isShown] = await Promise.all([
    drawnState($),
    read($, TAB),
    read($, UNFOLDED),
    isPaneShown($),
  ])
  const { ledger, prViews: prState, lastActions, stop, isDemo, isUnread, view, now } = drawn
  const prs = drawnPrs(prState, ledger.prs, lastActions, now)
  const prViews = prs.filter(x => !x.isSettled).map(x => x.pr)
  const ids = tabRowIds(view, prViews)
  const settledNeedsYou = settledRowIds([...view.needsYou.questions, ...view.needsYou.tasks])
  if (isOpening) recordedRows = null
  // A PR fetch's rows count once it ends. A new PR counts even with no rows. A row
  // that just closed is still recorded, so it does not count as new if Undo brings it back.
  const added = newRows(isDemo, {
    needsYou: [...ids.needsYou, ...settledNeedsYou],
    findings: [...ids.findings, ...settledRowIds(view.findings.rows)],
    prs: prState.isFetching ? null : [...prs.map(x => `pr ${x.pr.ref}`), ...ids.prs],
  })
  if (!isShown) return
  // A tab that drew its first waiting row open keeps that row open when rows arrive above it. PR rows arrive from a
  // fetch and are left out, as they are when the pane follows new rows.
  const keeps = (['needsYou', 'findings'] as const).flatMap(t => {
    const id = added[t].length > 0 ? keptOpen(tabWaits(t, view, prViews, lastActions), added[t]) : null
    return id === null ? [] : [{ t, cursor: { id, index: ids[t].indexOf(id), openedAt: 0 } }]
  })
  if (keeps.length > 0) {
    await update($, SELECTION, s => {
      const next = { ...s }
      for (const { t, cursor } of keeps) if (s[t].id === null && s[t].openedAt === 0) next[t] = cursor
      return next
    })
    // Rows that arrive above push the kept row down, so an inline pane scrolls it back to the window's top.
    if (isInlinePane && keeps.some(k => k.t === tab)) void scrollToOpenRow($, tab)
  }
  // A tab is empty while it shows only its empty text.
  const isEmpty = {
    needsYou:
      ids.needsYou.length === 0 &&
      settledNeedsYou.length === 0 &&
      !stop &&
      !isUnread &&
      !unfolded.some(kind => ledger.closed.some(d => d.kind === kind)),
    findings:
      view.findings.rows.length === 0 && !unfolded.some(kind => view.findings.closed.some(f => f.kind === kind)),
    prs: prs.length === 0 && !prState.isFetching,
  }[tab]
  // Opening, the pane moves toward the rows each tab lists, as it later does toward rows that just appeared.
  const to = followTo(
    TABS.map(t => t.id),
    tab,
    isEmpty,
    isOpening ? { needsYou: ids.needsYou, findings: ids.findings, prs: [] } : added,
  )
  if (to) await jumpTo($, to)
}

async function isPaneShown($: EngineInterface) {
  return (await $.ui.panes().catch(() => [])).some(p => p.id === PANE && p.isShown)
}

/** The PRs tab is on screen, so the current branch's PR is worth looking up. */
async function isPrsTabShown($: EngineInterface) {
  return (await read($, TAB)) === 'prs' && (await isPaneShown($))
}

/** What the person has on screen besides the conversation, for the ledger model. */
async function screen($: EngineInterface) {
  const tab = await read($, TAB)

  return screenText(CLAUDE_CODE, await isPaneShown($), TABS.find(t => t.id === tab)?.label ?? tab)
}

/** Closes the open tasks whose exact command the person ran in shell mode. */
async function closeTasksRunBy($: EngineInterface, command: string) {
  const ran = tasksRunBy(await read($, LEDGER), command)
  if (ran.length === 0) return
  const now = await $.clock.now()
  await commitLedger($, l =>
    ran.reduce((after, item) => closeItem(after, item.id, { how: 'done', outcome: 'you ran it' }, now), l),
  )
}

async function gh($: EngineInterface, args: string[]) {
  return $.process.run(['gh', ...args], { cwd: root, timeoutMs: 20_000 })
}

/** gh as the shared PR fetch runs it, and the clock it stamps fetches with. */
async function ghFor($: EngineInterface): Promise<{ run: GhRun; now: () => number }> {
  const at = await $.clock.now()

  return { run: args => gh($, args), now: () => at }
}

/** Remembers PRs this session created or linked, newest last. */
async function linkPrs($: EngineInterface, refs: string[]) {
  if (refs.length === 0) return
  const linked = (await read($, LEDGER)).prs
  if (refs.every(r => linked.includes(r))) return
  await commitLedger($, l => ({ ...l, prs: linkedPrs(l.prs, refs) }))
  void fetchPrs($, await isPrsTabShown($))
}

/**
 * Refreshes every PR the tab shows: the linked ones and the current branch's.
 * Only `findsBranchPr` asks gh which PR the branch has; otherwise the last one
 * found is refreshed by its ref. One fetch runs at a time. A request made
 * while one runs waits for it, joined with any other request waiting.
 */
function fetchPrs($: EngineInterface, findsBranchPr: boolean): Promise<void> {
  if (nextFetchFindsBranchPr !== null) {
    nextFetchFindsBranchPr ||= findsBranchPr
    return fetchingPrs
  }
  nextFetchFindsBranchPr = findsBranchPr
  fetchingPrs = fetchingPrs
    .then(() => {
      const finds = nextFetchFindsBranchPr ?? false
      nextFetchFindsBranchPr = null
      return fetchPrsNow($, finds)
    })
    .catch(() => undefined)

  return fetchingPrs
}

async function fetchPrsNow($: EngineInterface, findsBranchPr: boolean) {
  const state = await update($, PR_VIEWS, v => ({ ...v, isFetching: true }))
  try {
    const linked = (await read($, LEDGER)).prs
    const { run, now: fetchedAt } = await ghFor($)
    const { views: fetched, branchRef } = await fetchTracked(run, fetchedAt, state, linked, findsBranchPr)
    // A PR dismissed while the fetch ran stays dismissed.
    const [stillLinked, lastActions, now] = await Promise.all([
      read($, LEDGER).then(l => l.prs),
      read($, LAST_ACTIONS),
      $.clock.now(),
    ])
    const views = Object.fromEntries(
      Object.entries(fetched).filter(([ref]) => isTracked({ ...state, branchRef }, stillLinked, ref)),
    )
    // A fetch queued behind this one keeps the tab checking, so it does not show "No PRs" in between.
    // A PR dismissed moments ago keeps its last view while its block shows settled.
    await update($, PR_VIEWS, v => ({
      views: {
        ...views,
        ...Object.fromEntries(
          Object.entries(v.views).filter(([ref]) => !(ref in views) && isDismissing(lastActions, ref, now)),
        ),
      },
      branchRef,
      isFetching: nextFetchFindsBranchPr !== null,
    }))
  } catch {
    await update($, PR_VIEWS, v => ({ ...v, isFetching: nextFetchFindsBranchPr !== null }))
  }
  void followNewRows($).catch(() => undefined)
}

/** The timed refresh, which runs only while the person is around and there is a PR to show or the PRs tab is open. */
async function pollPrs($: EngineInterface) {
  const [presence, ledger, prs, findsBranchPr] = await Promise.all([
    read($, PRESENCE),
    read($, LEDGER),
    read($, PR_VIEWS),
    isPrsTabShown($),
  ])
  if (presence.isAway || (!findsBranchPr && ledger.prs.length === 0 && prs.branchRef === null)) return
  await fetchPrs($, findsBranchPr)
}

/** Opens a URL in the browser. Returns why it could not, or null. */
async function openUrl($: EngineInterface, url: string): Promise<string | null> {
  const r = await $.process.run(['open', url])

  return r.exitCode === 0 ? null : r.stderr.trim() || `open exited ${r.exitCode}`
}

/**
 * Drops a dismissed PR's view once the settled block of the Dismiss made `at`
 * has left. Not when Undo tracks the PR again, or a later Dismiss settles it
 * anew. The tab already leaves out a PR it no longer tracks, so a reload that
 * cancels this leaves only a view the next fetch drops.
 */
function leavePr($: EngineInterface, ref: string, at: number) {
  later($, SETTLED_MS, async () => {
    const [linked, mark] = await Promise.all([
      read($, LEDGER).then(l => l.prs),
      read($, LAST_ACTIONS).then(a => a[prMarkId(ref)]),
    ])
    if (mark?.action !== 'pr-dismiss' || mark.at !== at) return
    await update($, PR_VIEWS, v => {
      if (isTracked(v, linked, ref) || !(ref in v.views)) return v
      const { [ref]: _left, ...views } = v.views
      return { ...v, views }
    })
  })
}

/** The row any press was drawn on. */
function pressRowId(p: RowPress | PrPress): string {
  return 'ref' in p ? prRowId(p) : p.id
}

const COPY_FAILURES: Record<Extract<UiCopyResult, { isCopied: false }>['reason'], string> = {
  'no-surface': 'no app is attached',
  'no-clipboard': 'the clipboard did not take it',
  refused: 'another plugin refused it',
}

/** Opens a path or URL, or copies text, for a Local press. Returns why it could not, or null. */
async function perform(
  $: EngineInterface,
  e: Exclude<Effect, { kind: 'send' }>,
  surface: UiPressArgument['surface'],
): Promise<string | null> {
  try {
    if (e.kind === 'open')
      return await (/^[a-z][a-z\d+.-]*:\/\//i.test(e.target) ? openUrl($, e.target) : openPath($, e.target))
    const r = await $.ui.copy({ text: e.text, surface })
    return r.isCopied ? null : COPY_FAILURES[r.reason]
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Tells an idle agent the person did tasks it waits on, as `doneWake` decides. The closes are marked sent first, so
 * an Undo pressed during the send leaves them closed. A send that does not enter keeps the mark, and Claude reads
 * them beside the next prompt.
 */
async function wakeForDone($: EngineInterface) {
  const now = await $.clock.now()
  let wake: ReturnType<typeof doneWake> = null
  await commitLedger($, l => {
    wake = doneWake(l, { now, windowMs: SETTLED_MS, isTurnRunning })
    return wake ? markSentToAgent(l, wake.ids) : l
  })
  const sending = wake as ReturnType<typeof doneWake>
  if (!sending) return
  await send($, sending.text, { id: sending.ids[0] ?? '', action: 'done' })
}

/**
 * Runs a press from the pane, by click or key. A row press goes through
 * `applyPress` on the ledger, a PR press through `applyPrPress`. The row's last
 * action records it, then opens and copies run and their result replaces the
 * pending one on the row, then sends. A press whose row
 * is gone or changed sends nothing: the row, or the pane's status line, says so.
 */
async function runPress($: EngineInterface, p: RowPress | PrPress, surface: UiPressArgument['surface']) {
  // Undo is pressed on a row that just closed, and a PR block's actions on no row.
  const rowId = pressRowId(p)
  if (p.action !== 'undo' && !rowId.startsWith('pr:')) await keepPressedOpen($, rowId)
  const wasWaiting = (await shownWaits($)).rows.some(r => r.id === rowId && r.isWaiting)
  if (await read($, DEMO)) return runDemoPress($, p, wasWaiting)
  const [now, presence, lastActions, prState] = await Promise.all([
    $.clock.now(),
    read($, PRESENCE),
    read($, LAST_ACTIONS),
    read($, PR_VIEWS),
  ])
  const ctx = { now, turnsStarted: presence.turnsStarted }
  let applied = { stale: true } as Applied
  if ('ref' in p && p.action !== 'pr-dismiss' && p.action !== 'pr-undo') {
    applied = applyAnyPress(await read($, LEDGER), prState, lastActions, p, ctx)
  } else {
    if (!('ref' in p) && p.action === 'type') await update($, TYPING, t => (t === p.id ? null : t))
    // `update` may run the change again on a version miss; the last run's result is the one used.
    await commitLedger($, l => {
      applied = applyAnyPress(l, prState, lastActions, p, ctx)
      return 'stale' in applied ? l : applied.ledger
    })
  }

  const pressed = applied
  if ('stale' in pressed) {
    await Promise.all([
      update($, NOTES, n => ({ ...n, [rowId]: { note: 'stale' as const, at: now } })),
      'id' in p && p.action === 'type' ? update($, DRAFTS, d => ({ ...d, [p.id]: p.text })) : undefined,
    ])
    // The note shows for SETTLED_MS. Removing it then also redraws the pane.
    later($, SETTLED_MS, () =>
      update($, NOTES, n => {
        if (n[rowId]?.at !== now) return n
        const { [rowId]: _gone, ...rest } = n
        return rest
      }),
    )
    return
  }
  const lasts = Object.values(pressed.lasts)
  await Promise.all([
    lasts.length > 0 || pressed.drop.length > 0
      ? update($, LAST_ACTIONS, a => withLasts(a, pressed.lasts, pressed.drop))
      : undefined,
    // A press that went through replaces the row's note, and a sent reply its draft.
    update($, NOTES, n => {
      if (!(rowId in n)) return n
      const { [rowId]: _gone, ...rest } = n
      return rest
    }),
    'id' in p && p.action === 'type'
      ? update($, DRAFTS, d => {
          const { [p.id]: _sent, ...rest } = d
          return rest
        })
      : undefined,
  ])
  // The sidebar line stops counting a handed-off row at once.
  if (lasts.some(l => l.kind === 'handoff')) void publishStatus($)
  const isMoved = await openAfterClose($, rowId, wasWaiting)
  if (!('ref' in p) && p.action === 'done') later($, SETTLED_MS, () => wakeForDone($))
  // Fix settles its finding's row as a close does, so it leaves once SETTLED_MS ends.
  if (!('ref' in p) && p.action === 'address') redrawWhileLeaving($, SETTLED_MS)
  if ('ref' in p && p.action === 'pr-dismiss') {
    redrawWhileLeaving($, SETTLED_MS)
    leavePr($, p.ref, now)
  }
  if (!('ref' in p) && p.action === 'undo') {
    // Claude was told of the close; with the id out of `told`, a second close of the row is reported too.
    told = { ...told, closed: told.closed.filter(id => id !== p.id) }
    await selectRestored($, p.id)
  }
  const rows = Object.keys(pressed.lasts)
  const host: EffectHost = {
    now: () => $.clock.now(),
    perform: e => perform($, e, surface),
    send: async e => {
      const sent = await send($, e.text, e.by)
      if (!('entered' in sent)) return sent.notSent
      if (sent.entered !== e.text) await awaitRewritten($, rows, now, e.text, sent)
      return null
    },
    saveLasts: change => update($, LAST_ACTIONS, change),
    saveLedger: change => commitLedger($, change),
  }
  const result = await runLocalEffects(host, pressed.effects, rowId, pressed.lasts[rowId]?.result)
  // A success note clears after SETTLED_MS. A fresh value is what redraws the pane then.
  if (result?.state === 'done') later($, SETTLED_MS, () => update($, LAST_ACTIONS, a => ({ ...a })))
  // A message still on its way after QUEUED_AFTER_MS reads Queued from then. A fresh value is what redraws the pane.
  if (pressed.effects.some(e => e.kind === 'send'))
    later($, QUEUED_AFTER_MS, () => update($, LAST_ACTIONS, a => ({ ...a })))
  const failed = await runSends(host, pressed.effects, rowId, rows, now)
  if (!failed) return
  // A typed reply that did not send goes back into its draft.
  if (failed.isRowFailed && !('ref' in p) && p.action === 'type')
    await update($, DRAFTS, d => (d[p.id] ? d : { ...d, [p.id]: p.text }))
  // A press that did not send gave nothing away, so its row opens again to show why, with [Try again].
  if (failed.isRowFailed && isMoved) await reopenPressed($, rowId)
  void publishStatus($)
}

/**
 * Has a press's rows wait for its prompt as another plugin rewrote it, since the
 * stored row carries that text. A row stored before the rewrite was known arrives here.
 */
async function awaitRewritten(
  $: EngineInterface,
  rows: string[],
  at: number,
  message: string,
  sent: Extract<Sent, { entered: string }>,
) {
  await update($, LAST_ACTIONS, a => {
    const moved = withRewrite(a, rows, at, message, sent.entered)

    return isStoredSince(sent.entered, sent.since) ? withArrival(moved, sent.entered) : moved
  })
  void publishStatus($)
}

/** Applies a row press with `applyPress` or a PR press with `applyPrPress`. Pure. */
function applyAnyPress(
  ledger: Ledger,
  prState: PrViews,
  lastActions: Record<string, LastAction>,
  p: RowPress | PrPress,
  ctx: { now: number; turnsStarted: number },
): Applied {
  if ('ref' in p) return applyPrPress(ledger, prState, lastActions, p, ctx)
  const item = ledger.items.find(i => i.id === p.id)
  const r = applyPress(ledger, lastActions[p.id], p, {
    ...ctx,
    extraSteps: item ? itemPrSteps(item, prState, ledger.prs) : [],
  })
  if ('stale' in r) return r

  return { ledger: r.ledger, lasts: r.last ? { [p.id]: r.last } : {}, drop: [], effects: r.effects }
}

/** The shown tab's rows in drawn order, whether each still waits on the person, and each one's place for the cursor. */
async function shownWaits($: EngineInterface) {
  const [{ ledger, prViews: prState, lastActions, view, now }, tab] = await Promise.all([drawnState($), read($, TAB)])
  const prViews = drawnPrs(prState, ledger.prs, lastActions, now)
    .filter(x => !x.isSettled)
    .map(x => x.pr)

  return {
    tab,
    rows: tabWaits(tab, view, prViews, lastActions),
    ids: tabRowIds(view, prViews)[tab],
  }
}

/**
 * Once a press stopped the shown tab's open row `id` waiting on the person, as an answer, a close or a hand-off does,
 * opens the next row that still waits. With none waiting, the tab goes back to opening its first waiting row, so a
 * row a later reply brings opens. Returns whether it moved the open row.
 */
async function openAfterClose($: EngineInterface, id: string, wasWaiting: boolean): Promise<boolean> {
  const [{ tab, rows, ids }, selection] = await Promise.all([shownWaits($), read($, SELECTION)])
  if (!wasWaiting || selection[tab].id !== id || rows.find(r => r.id === id)?.isWaiting) return false
  const next = rowAfterClose(rows, id)
  const index = next === null ? -1 : ids.indexOf(next)
  if (next !== null && index >= 0) await select($, tab, next, index)
  else await update($, SELECTION, s => ({ ...s, [tab]: { ...NO_CURSOR, index: s[tab].index } }))

  return true
}

/**
 * Opens again the row a hand-off closed, where it was. Unguarded, as `keepPressedOpen` leaves a row: the person
 * was pressing on it, so [Try again] takes a click at once.
 */
async function reopenPressed($: EngineInterface, id: string) {
  const tab = await read($, TAB)
  await update($, SELECTION, s => ({ ...s, [tab]: { id, index: s[tab].index, openedAt: 0 } }))
}

/** Selects a row Undo brought back, in its own tab. */
async function selectRestored($: EngineInterface, id: string) {
  const ids = tabRowIds((await drawnState($)).view, [])
  const tab: Tab = ids.findings.includes(id) ? 'findings' : 'needsYou'
  const index = ids[tab].indexOf(id)
  if (index >= 0) await select($, tab, id, index)
}

/**
 * Runs a press on the demo's copy. It changes only the copy and performs
 * nothing: each send, open or copy becomes its row's sample note instead, except in a recording.
 * Rows still settle, fold, undo and show their ✓ on the copy.
 */
async function runDemoPress($: EngineInterface, p: RowPress | PrPress, wasWaiting: boolean) {
  const now = await $.clock.now()
  const rowId = pressRowId(p)
  if (!('ref' in p) && p.action === 'type') await update($, TYPING, t => (t === p.id ? null : t))
  let applied = { stale: true } as Applied
  let isClosing = false
  const isRecording = await read($, DEMO_RECORDING)
  await update($, DEMO, d => {
    if (!d) return d
    // The copy's own turn counts, so a sample hand-off folds by them.
    const r = applyAnyPress(d.ledger, d.prViews, d.lastActions, p, { now, turnsStarted: d.turns.turnsStarted })
    applied = r
    const { [rowId]: _replaced, ...notes } = d.notes
    if ('stale' in r) return { ...d, notes: { ...notes, [rowId]: { note: 'stale' as const, at: now } } }
    isClosing = hasNewClose(d.ledger, r.ledger) || ('ref' in p ? p.action === 'pr-dismiss' : p.action === 'address')
    const { lasts, isSample } = demoRecord(r.lasts, r.effects)

    return {
      ...d,
      ledger: r.ledger,
      lastActions: withLasts(d.lastActions, lasts, r.drop),
      notes: isSample && !isRecording ? { ...notes, [rowId]: { note: 'sample' as const, at: now } } : notes,
      turns: demoTurns(d.turns, r.effects),
    }
  })
  const pressed = applied
  if (!('ref' in p) && p.action === 'type')
    await update($, DRAFTS, d => {
      if ('stale' in pressed) return { ...d, [p.id]: p.text }
      const { [p.id]: _sent, ...rest } = d
      return rest
    })
  if (!('stale' in pressed) && !('ref' in p) && p.action === 'undo') await selectRestored($, p.id)
  if (!('stale' in pressed)) await openAfterClose($, rowId, wasWaiting)
  // A fresh copy redraws the pane: once a note's SETTLED_MS ends, with the sample reply to a sample message, and at
  // each step of a leave bar.
  if ('stale' in pressed || pressed.effects.length > 0)
    later($, SETTLED_MS, () => update($, DEMO, d => d && { ...d, turns: demoTurns(d.turns, [], true) }))
  if (isClosing) redrawWhileLeaving($, SETTLED_MS)
}

type Action = {
  key: string
  label: string
  /** The recommended option. The terminal and desktop looks mark it, and desktop draws it as the primary button. */
  variant?: 'primary'
  /** The press that finishes the row, as Done or Address. Desktop draws it as the primary button. */
  isMain?: boolean
  /** A glyph desktop draws before the label, naming what the press does, as ⧉ for a copy. */
  icon?: string
  dimColor?: boolean
  /**
   * What the press does. A Talk or Hand-off press leaves "✓ <label>"
   * on its row, so the person sees it went through, and a Hand-off folds the
   * row. A Local press shows "Opening x…" on its row, then its result. The
   * other kinds show themselves: the row closes, a field opens, or the screen changes.
   */
  kind: PressKind
  /**
   * Returns the press's work for its Button to return. A hot reload keeps work an `onPress`
   * returns and drops work it leaves running, so a returned press's result still lands.
   */
  onPress: (press: UiPressArgument) => void | Promise<void>
}

/** The steps that open the PRs the session tracks that an item's ask names. */
function itemPrSteps(item: Item, prState: PrViews, linked: string[]): HelpStep[] {
  const refs = prState.branchRef ? [...linked, prState.branchRef] : linked

  return prSteps(
    item,
    refs.map(ref => ({ ref, url: prState.views[ref]?.url ?? null })),
  )
}

/** A pane action with the key that presses it while the pane has focus, if it has one. */
type KeyAction = Action & { hotkey?: string }

const STEP_GLYPHS = { run: '▶', copy: '⧉', open: '↗' } as const

/** A step's icon: ▶ when it asks Claude to run a command, else ⧉ for a copy and ↗ for an open. */
function stepIcon(step: HelpStep | undefined): string | undefined {
  const kind = stepIconKind(step)

  return kind && STEP_GLYPHS[kind]
}

/** A question, task or finding's keys, in the order `rowKeyPlan` sets, as the pane's actions. */
function rowKeyActions(
  $: EngineInterface,
  look: Look,
  r: RowView,
  isAllShown: boolean,
): { keys: KeyAction[]; more: KeyAction[]; hidden: KeyAction[] } {
  const { id, item, finding } = r
  const keyAction = (k: PlannedKey): KeyAction => {
    switch (k.slot) {
      case 'retry':
        return {
          key: `retry-${id}`,
          label: 'Try again',
          icon: '↻',
          kind: k.kind,
          onPress: press => runPress($, k.press, press.surface),
        }
      case 'allOptions':
        return {
          key: `all-options-${id}`,
          label: `All ${k.count} options`,
          kind: 'view',
          onPress: () => void update($, OPTIONS_SHOWN, s => (s.includes(id) ? s : [...s, id])),
        }
      case 'choice': {
        const { action: a, hotkey } = k
        const p = a.press
        const base = {
          label: a.label,
          kind: a.kind,
          ...(hotkey ? { hotkey } : {}),
          onPress: (press: UiPressArgument) => runPress($, p, press.surface),
        }
        if (p.action === 'answer')
          return {
            ...base,
            key: `answer-${id}-${(item?.options ?? []).indexOf(p.option)}`,
            ...(a.isPrimary ? { variant: 'primary' as const } : {}),
          }
        const icon = stepIcon(r.steps[p.step])
        return { ...base, ...(icon ? { icon } : {}), key: `help-${id}-${p.step}` }
      }
      case 'action': {
        const { action: a, hotkey } = k
        const p = a.press
        const main = a.isFollowUp ? {} : { isMain: true }
        // Type's press opens the field; sending from it is what records the reply.
        if (p.action === 'type')
          return {
            label: a.label,
            kind: 'view',
            key: `typekey-${id}`,
            hotkey,
            ...main,
            onPress: () => void startTyping($, id),
          }
        return {
          label: a.label,
          kind: a.kind,
          key: p.action === 'dismiss' && finding ? `drop-${id}` : `${p.action}-${id}`,
          hotkey,
          ...main,
          onPress: press => runPress($, p, press.surface),
        }
      }
    }
  }
  const { keys, more, hidden } = rowKeyPlan(r, isAllShown, look !== 'desktop')

  return { keys: keys.map(keyAction), more: more.map(keyAction), hidden: hidden.map(keyAction) }
}

/** A closed item, or a closed finding by its title, as its list's Closed fold draws it. */
type ClosedLine = Pick<Closed, 'id' | 'ask' | 'at' | 'how' | 'outcome'>

/** The outcome as the pane shows it: "Dismissed", "Yes, renamed". */
function outcomeText(d: Pick<Closed, 'outcome'>): string {
  return capitalized(d.outcome)
}

/**
 * The desktop tab bar's sizes for `columns`: each tab's width, the gap between tabs, and whether the counts
 * show. A label is sized as bold text at DESKTOP_CHARS_PER_CELL plus 1 cell of slack. While the tabs do not
 * fit, the padding drops from 2 to 1, then the gap, then the counts.
 */
function desktopTabSizes(
  tabs: { label: string; count: number }[],
  columns: number,
): { widths: number[]; gap: number; hasCounts: boolean } {
  const steps = [
    { padding: 1, gap: 1, hasCounts: true },
    { padding: 0, gap: 1, hasCounts: true },
    { padding: 0, gap: 0, hasCounts: true },
    { padding: 0, gap: 0, hasCounts: false },
  ]
  const sizes = steps.map(({ padding, gap, hasCounts }) => ({
    widths: tabs.map(t => {
      const text = hasCounts && t.count > 0 ? `${t.label}${TAB_COUNT_GAP}${t.count}` : t.label
      // A tab's rounded frame insets its label FRAME_INSET_PT on each side, so its width adds those columns,
      // rounded up, to what the label needs. Narrower, the label wraps inside the tab.
      return (
        Math.ceil(text.length / DESKTOP_CHARS_PER_CELL) + Math.ceil((2 * FRAME_INSET_PT) / DESKTOP_CELL_PT) + padding
      )
    }),
    gap,
    hasCounts,
  }))

  return (
    sizes.find(s => s.widths.reduce((sum, w) => sum + w, 0) + s.gap * (s.widths.length - 1) <= columns) ?? sizes.at(-1)!
  )
}

async function drawnState(
  $: EngineInterface,
): Promise<DemoCopy & { view: InboxView; isDemo: boolean; showsDemoNotices: boolean; isUnread: boolean; now: number }> {
  const [ledger, stop, prViews, lastActions, notes, presence, demo, isDemoRecording, unreadable, now] =
    await Promise.all([
      read($, LEDGER),
      read($, STOP),
      read($, PR_VIEWS),
      read($, LAST_ACTIONS),
      read($, NOTES),
      read($, PRESENCE),
      read($, DEMO),
      read($, DEMO_RECORDING),
      read($, UNREADABLE),
      $.clock.now(),
    ])
  const turns = { turnsStarted: presence.turnsStarted, turnsApplied: presence.turnsApplied }
  const drawn = demo ?? { ledger, stop, prViews, lastActions, notes, turns }

  // Needs you says this conversation's saved session could not be read, but not over the demo's samples.
  const isUnread = demo === null && unreadable === sessionId

  return {
    ...drawn,
    view: viewOf({ ...drawn, now }, presence),
    isDemo: demo !== null,
    showsDemoNotices: demo !== null && !isDemoRecording,
    isUnread,
    now,
  }
}

/**
 * Shows the demo's sample entries on a fresh copy, or ends the demo. For a recording, the demo leaves out the notices
 * that mark its entries as samples, so a video can show them as a session's own.
 */
async function setDemo($: EngineInterface, isShown: boolean, isRecording = false) {
  const now = await $.clock.now()
  await Promise.all([
    update($, DEMO, () => (isShown ? demoView(now) : null)),
    update($, DEMO_RECORDING, () => isShown && isRecording),
  ])
  // The open rows and the field name the other entries' ids, so each tab draws its top row open again.
  await Promise.all([update($, SELECTION, () => NO_SELECTION), update($, TYPING, () => null)])
  // The copy starts with a row that just closed, whose leave bar runs down.
  if (isShown) redrawWhileLeaving($, SETTLED_MS)
  // findPrs does nothing during the demo, so the real PRs tab looks up the branch's PR once it ends.
  if ((await read($, TAB)) === 'prs') await findPrs($)
  await followNewRows($, true)
}

/** Turns the mod on for this session, once, from the start or the desktop app's attach. */
async function turnOn($: EngineInterface) {
  // A hot reload keeps state an older build wrote. Draws start once isOn is set, and they read the current shape.
  await upgradeState($)
  isOn = true
  toolsRefused = false
  // A refused registration rejects. Each is caught on its own, so the mod still loads the conversation.
  const refused = () => {
    toolsRefused = true
  }
  const findingText = findingDescription(CLAUDE_CODE)
  await Promise.all([
    // /inbox only opens the pane, so it runs at once instead of waiting for the running turn to end.
    $.command.register({
      name: 'inbox',
      description: 'Show where this session stands and what is waiting on you',
      immediate: true,
    }),
    $.tool.register({ name: 'record_finding', description: findingText, inputSchema: FINDING_SCHEMA }).catch(refused),
    $.tool.register({ name: 'close', description: CLOSE_DESCRIPTION, inputSchema: CLOSE_SCHEMA }).catch(refused),
  ])
  // A pane kept across a hot reload is already drawn.
  if (toolsRefused) await redrawPane($)
  $.clock.every(60_000, () => {
    void tick($)
  })
  $.clock.every(PR_POLL_MS, () => {
    void pollPrs($)
  })
  await loadConversation($, await $.session.id())
  // After loadConversation, which brings saved state up to date.
  await redrawAfterReload($)
}

/**
 * Loads the conversation `id` the session runs: at the start, and after
 * /clear, /resume or /branch, which switch conversations under a new session
 * id without a session.start.
 */
async function loadConversation($: EngineInterface, id: string) {
  sessionId = id
  root = await $.session.root()
  isSaved = false
  recordedRows = null
  isReadingAgain = false
  // A reload stops any update the previous load had running, and state outlives
  // it, so an update in flight at load was cut off: record it as failed.
  // The theme read at the start is gone after /clear, so each conversation reads it.
  const [presence, current, saved] = await Promise.all([
    update($, PRESENCE, p => (p.isUpdating ? { ...p, isUpdating: false, ledgerState: 'failed' as const } : p)),
    upgradeState($),
    readSaved($, id),
    syncTheme($),
  ])
  // Only a conversation with no turns loaded yet needs its saved copy, so only that load's read decides
  // whether the copy is unreadable. Once turns ran, only [Try again] or another conversation clears UNREADABLE.
  const isFresh = current.turn === 0 && !current.card
  const isUnread =
    (await update($, UNREADABLE, u => (isFresh ? (saved === null ? id : null) : u === id ? u : null))) === id
  const loaded = saved === null ? current : await bringBack($, current, saved.session)
  // Catch up now after a failed update; after a turn whose reply never reached
  // the ledger, as when a reload cut off the end-of-turn hook before it queued the
  // update; or when the ledger is empty in a conversation that already has turns:
  // the mod loaded mid-session, or its saved state was lost. A saved session the
  // store could not read is not lost, so [Try again] can still bring it back.
  const isEmpty = !loaded.card && loaded.items.length === 0
  const { turnsStarted, turnsApplied } = await read($, PRESENCE)
  if (
    presence.ledgerState !== 'current' ||
    turnsStarted > turnsApplied ||
    (!isUnread && isEmpty && (await $.session.turns().catch(() => 0)) > 0)
  )
    queueUpdate($, null)
  void publishStatus($)
  // A resumed session's linked PRs; the branch's PR waits for the PRs tab.
  if (loaded.prs.length > 0) void fetchPrs($, false)
}

type SavedSession = { savedAt: number; ledger: Ledger }

/** Conversation `id`'s saved session, `session` undefined when it has none; null when the store could not read it. */
async function readSaved($: EngineInterface, id: string): Promise<{ session: SavedSession | undefined } | null> {
  try {
    return { session: (await $.store.get(`s:${id}`)) as SavedSession | undefined }
  } catch {
    return null
  }
}

/**
 * Into a conversation with no turns yet, brings back its saved session, shown as
 * a return. Returns the ledger now in place.
 */
async function bringBack($: EngineInterface, current: Ledger, session: SavedSession | undefined): Promise<Ledger> {
  if (current.turn !== 0 || current.card || !session) return current
  const loaded = upgradeLedger(session.ledger)
  await update($, LEDGER, () => loaded)
  await update($, PRESENCE, p => ({ ...p, lastActiveAt: session.savedAt, isAway: true }))

  return loaded
}

/**
 * Puts the saved ledger in place of one built since the read failed, keeping the
 * prompt count of the turns since. The saved ledger reuses the replaced one's ids
 * for other rows, so updates queued on the replaced ledger are dropped, as is pane
 * state kept by id; the caller's catch-up covers their turns. What only the
 * replaced ledger held is lost.
 */
async function restore($: EngineInterface, current: Ledger, saved: Ledger): Promise<Ledger> {
  conversation += 1
  const loaded = upgradeLedger(saved)
  const [restored] = await Promise.all([
    update($, LEDGER, () => ({ ...loaded, turn: loaded.turn + current.turn })),
    forgetRowState($),
  ])

  return restored
}

/**
 * Forgets the pane state kept by row id, when another ledger takes the pane. Ids restart
 * at i1 in each ledger, so a kept id would open or unfold another row, or put one row's
 * words or note on another.
 */
async function forgetRowState($: EngineInterface) {
  await Promise.all([
    update($, SELECTION, () => NO_SELECTION),
    update($, TYPING, () => null),
    update($, UNFOLDED, () => []),
    update($, OPTIONS_SHOWN, () => []),
    update($, DRAFTS, () => ({})),
    update($, NOTES, () => ({})),
    // Thread and `pr:` entries stay: the branch PR outlives the ledger, and isThreadSent reads them.
    update($, LAST_ACTIONS, a => Object.fromEntries(Object.entries(a).filter(([k]) => !/^[if]\d+$/.test(k)))),
  ])
  fieldSeeds.clear()
}

/** Reads the saved session again after the store could not, as [Try again] does, and brings it back. */
async function readAgain($: EngineInterface) {
  if (isReadingAgain) return
  isReadingAgain = true
  const id = sessionId
  if ((await read($, UNREADABLE)) !== id) {
    isReadingAgain = false
    return
  }
  await redrawPane($)
  const saved = await readSaved($, id)
  // A conversation loaded meanwhile has its own read, and its load cleared isReadingAgain.
  if (sessionId !== id) return
  isReadingAgain = false
  if (saved !== null) {
    await update($, UNREADABLE, () => null)
    const current = await read($, LEDGER)
    const hasRun = current.turn !== 0 || current.card !== null
    const loaded =
      hasRun && saved.session
        ? await restore($, current, saved.session.ledger)
        : await bringBack($, current, saved.session)
    if (
      (hasRun && saved.session) ||
      (!loaded.card && loaded.items.length === 0 && (await $.session.turns().catch(() => 0)) > 0)
    )
      queueUpdate($, null)
    void publishStatus($)
    if (loaded.prs.length > 0) void fetchPrs($, false)
    void followNewRows($).catch(() => undefined)
  }
  await redrawPane($)
}

/** Redraws the pane after a change only a module flag holds, which no draw subscribes to. */
function redrawPane($: EngineInterface) {
  return update($, SELECTION, s => ({ ...s }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // The desktop app runs its sessions headless and attaches to them, before
    // or after this start. -p, the SDK and VS Code draw nothing, so the mod stays off there.
    if (e.isInteractive || (await $.session.surfaces()).includes('desktop')) await turnOn($)

    return r
  })

  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    if (!isOn) await turnOn($)

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const r = await next(e)
    // $.session.id() still names the previous conversation here, so the new id comes
    // from the event. A start with --resume also raises this, for the conversation
    // session.start already loaded.
    if (isOn && e.session_id !== sessionId) await loadConversation($, e.session_id)

    return r
  })

  on('session.end', async ($, e, next) => {
    // The pane outlives the session, so its sidebar line goes with it.
    if (isOn) {
      await Promise.all([
        update($, STOP, () => null),
        update($, DIALOGS, () => []),
        update($, DEMO, () => null),
        update($, DEMO_RECORDING, () => false),
        publishStatus($, true),
      ])
    }
    // /clear, /resume and /branch (which reports resume) go on in this process with another conversation.
    if (isOn && (e.reason === 'clear' || e.reason === 'resume')) {
      conversation += 1
      await Promise.all([
        update($, LEDGER, () => EMPTY),
        forgetRowState($),
        update($, PRESENCE, p => ({ ...p, isAway: false, isUpdating: false, ledgerState: 'current' as const })),
      ])
      resetTurn()
      shellCommand = null
      told = TOLD_NOTHING
      contextFor.clear()
      storedAt.clear()
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isOn) return next(e)
    const origin = e.origin
    // send() already recorded this mod's own prompts.
    if (origin.kind === 'plugin' && origin.name === 'inbox') return next(e)
    // The person's own words: typed, or sent as theirs by another plugin.
    const isPersonsWords =
      origin.kind === 'composer' || origin.kind === 'bridge' || (origin.kind === 'plugin' && origin.asUser === true)
    if (!isPersonsWords) {
      if (!e.turnId) trigger = origin.kind

      return next(e)
    }

    const notes = await notePrompt($, e.text, null)

    return notes.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    isTurnRunning = true
    // A turn that starts means the session runs again. Counted here, before the
    // turn can end, since a reload can cut off its end-of-turn hook.
    if (isOn)
      await Promise.all([setStop($, null), update($, PRESENCE, p => ({ ...p, turnsStarted: p.turnsStarted + 1 }))])

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!isOn) return r

    return {
      ...r,
      sections: [...r.sections, { id: 'inbox:guidance', text: guidanceText(CLAUDE_CODE), scope: 'session' as const }],
    }
  })

  // The inbox's tools are listed up front and answered here. A tool.call answer
  // settles the call before the permission check, so they raise no prompt.
  on('tool.describe', { tool: FINDING_TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.call', { tool: FINDING_TOOL }, async ($, e) => ({
    result: await runTool($, recordFinding, e as unknown as Record<string, unknown>),
  }))
  on('tool.describe', { tool: CLOSE_TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.call', { tool: CLOSE_TOOL }, async ($, e) => ({
    result: await runTool($, recordClose, e as unknown as Record<string, unknown>),
  }))

  on('tool.call', async ($, e, next) => {
    if (!isOn) return next(e)
    const { tool: _tool, tool_use_id: _id, agentId: _agent, ...input } = e as unknown as Record<string, unknown>
    const key = callKey(String(e.tool), input)
    const run = () => clearingDialog($, key, () => next(e))
    // A subagent's call can raise a permission prompt too, which the person answers.
    if (e.agentId) return run()
    const line = toolActivity(String(e.tool), input)
    if (line) noteActivity(line)
    if (e.tool === 'Bash') {
      const ran = await run()
      if (activity.length < 40)
        for (const url of new Set(ran.text?.match(LOCAL_URL) ?? [])) noteActivity(`URL in output: ${url}`)
      // A PR this session opened; other commands print PR links that are not this session's.
      if (/\bgh\s+pr\s+create\b/.test(e.command)) void linkPrs($, prRefs(ran.text ?? ''))

      return ran
    }
    if (e.tool === 'AskUserQuestion') {
      const questions = (Array.isArray(input.questions) ? input.questions : []) as { question?: unknown }[]
      const question = typeof questions[0]?.question === 'string' ? questions[0].question : 'A question'
      await openDialog($, { kind: 'question', text: question, key })
      // The answers come back in the tool result, never in a typed prompt, so
      // the ledger model only learns them from here.
      const ran = await run()
      noteActivity(dialogLine(ran.text ?? '', typeof resultFields(ran).afkTimeoutMs === 'number'))

      return ran
    }
    return run()
  })

  // A question dialog opens from its own tool call, which also raises a permission request.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (isOn && e.tool_name !== 'AskUserQuestion') {
      const input = (e.tool_input ?? {}) as Record<string, unknown>
      await openDialog($, {
        kind: 'permission',
        text: permissionText(e.tool_name, input),
        key: callKey(e.tool_name, input),
      })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    const r = await next(e)
    if (!isOn || e.agent_id) return r
    const message = e.last_assistant_message ?? ''
    await setStop($, {
      kind: stopKindOf(String(e.error), message),
      detail: String(e.error),
      resets: resetTime(message),
      at: await $.clock.now(),
    })

    return r
  })

  // A reply another Stop hook sent Claude back from never becomes the turn's
  // final answer, so it is kept for the per-reply update.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (!isOn || e.agent_id) return r
    const reply = e.last_assistant_message ?? ''
    if (reply.trim() && r.block) sentBack.push(reply)

    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    isTurnRunning = false
    // No dialog outlives the turn that raised it.
    await closeDialogs($, null)
    if (!isOn) return r
    // A Done pressed during the turn waited for it to end.
    void wakeForDone($).catch(() => undefined)
    void followNewRows($).catch(() => undefined)
    if (e.reason !== 'answer' || e.answer.trim() === '') return r

    const [ledger, shown, now] = await Promise.all([read($, LEDGER), screen($), $.clock.now()])
    const reply = [...sentBack, e.answer].join('\n\n')
    const ex: Exchange = {
      person,
      trigger,
      activity,
      reply,
      turn: ledger.turn,
      press,
      screen: shown,
    }
    resetTurn()
    const { turnsStarted } = await update($, PRESENCE, p => ({ ...p, lastActiveAt: now }))
    queueUpdate($, { ex, turnsStarted })
    await linkPrs($, prRefs(reply))

    return r
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (!isOn) return r
    const text = carryText(await read($, LEDGER), START_TITLE, true)

    return text ? { ...r, blocks: [...r.blocks, { name: 'inbox', text }] } : r
  })

  // A prompt this mod sent: its context goes in just before it, wherever the engine runs it.
  // Its row being stored is how the press that sent it learns it arrived.
  on(
    'session.append',
    { door: ['prompt', 'delivery'], origin: { kind: 'plugin', name: 'inbox' } },
    async ($, e, next) => {
      if (!isOn || e.agentId) return next(e)
      const text = messageText(e.message)
      storedAt.set(text, ++storedCount)
      const context = contextFor.get(text)
      contextFor.delete(text)
      if (context) await appendContext($, context)
      const r = await next(e)
      const isAwaited = Object.values(await read($, LAST_ACTIONS)).some(
        a => a.delivery?.state === 'queued' && a.delivery.message === text,
      )
      if (isAwaited) {
        await update($, LAST_ACTIONS, a => withArrival(a, text))
        void publishStatus($)
      }

      return r
    },
  )

  // The person's own `!` and slash commands reach no prompt.submit hook, only these rows.
  // The matcher keeps every other row from waking the hooks module.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    const r = await next(e)
    if (!isOn || e.agentId) return r
    const row = readCommandRow(messageText(e.message))
    if (!row) return r
    const line = commandRowLine(row)
    if (line) notePerson(line)
    if (row.kind === 'shell') {
      shellCommand = row.command
    } else if (row.kind === 'output') {
      // The row has no exit code, so only a run with nothing on stderr closes a
      // task here. The ledger model judges the rest from the output.
      if (shellCommand && !row.stderr) await closeTasksRunBy($, shellCommand)
      shellCommand = null
    } else if (row.name === 'login' && (await read($, STOP))?.kind === 'sign-in') {
      await setStop($, null)
    }

    return r
  })

  on('command.run', { command: 'inbox' }, async ($, e) => {
    const isShown = (await read($, DEMO)) !== null
    const args = e.args.trim().split(/\s+/).join(' ')
    if (args === 'demo' || args === 'demo recording') await setDemo($, !isShown, args === 'demo recording')
    else if ((await read($, TAB)) === 'prs') await findPrs($)
    const [isDemo, isDemoRecording] = await Promise.all([read($, DEMO).then(d => d !== null), read($, DEMO_RECORDING)])
    await showInbox($)

    return {
      text: !isDemo
        ? 'Opened the inbox.'
        : isDemoRecording
          ? 'Showing sample entries without their notices, for a recording. Run /inbox demo to go back.'
          : 'Showing sample entries in the inbox. Run /inbox demo again to go back.',
    }
  })

  // A desktop press focuses its Button. One that closes a row leaves Undo in the Button's place, and Type opens a field.
  on('ui.press', async ($, e, next) => {
    if (e.requestId === PANE && e.surface === 'desktop') {
      focusedKey = e.element
      focusHint = focusHintFor(e.element)
    }
    return next(e)
  })

  // The desktop tab bar's Client posts the tab a click landed on, a closed row's Client a click on the row,
  // a Closed fold's Client the fold state the click asks for, and an open row's follow-ups the key clicked.
  on('ui.message', async ($, e, next) => {
    const r = await next(e)
    if (e.requestId !== PANE) return r
    const data = e.data as { tab?: unknown; isUnfolded?: unknown; hover?: unknown; key?: unknown } | null
    const shown = TABS.find(t => t.id === data?.tab)
    const followUp = typeof data?.key === 'string' ? followUpPresses.get(data.key) : undefined
    if (e.element === 'tabs' && shown) await showTab($, shown.id)
    else if (e.element.startsWith('undo-') && followUp && typeof data?.key === 'string')
      followUp({
        plugin: 'inbox',
        element: data.key,
        component: e.component,
        requestId: e.requestId,
        surface: e.surface,
      })
    else if (e.element.startsWith('links-') && followUp && typeof data?.key === 'string') {
      // The Client is not a focusable key, so the next drawing moves the focus, to the hint first.
      focusedKey = e.element
      focusHint = focusHintFor(data.key)
      followUp({
        plugin: 'inbox',
        element: data.key,
        component: e.component,
        requestId: e.requestId,
        surface: e.surface,
      })
    } else if (e.element.startsWith('select-')) await selectClicked($, e.element.slice('select-'.length))
    else if (e.element.startsWith('fold-') && typeof data?.hover === 'boolean')
      await setFoldHover($, e.element.slice('fold-'.length), data.hover)
    else if (e.element.startsWith('fold-')) await setFold($, e.element.slice('fold-'.length), data?.isUnfolded)

    return r
  })

  // A field left open would take the keys again when the pane reopens, as Esc in it closes the pane.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    await update($, TYPING, () => null)
    await update($, FOLD_HOVER, () => null)

    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isOn || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const [{ ledger, stop, view, showsDemoNotices, now }, theme] = await Promise.all([drawnState($), read($, THEME)])
    if (!stop && !ledger.card && ledger.items.length === 0 && ledger.findings.length === 0) return next(e)
    const pal = paletteFor(theme, lookOf(e.surface))
    // Each count as its tab reads: the tab's name, muted, then the count in the tab's color.
    const counts = ROW_TABS.filter(t => view[t.id].count > 0).map(t => (
      <Text>
        <Text dimColor>{t.label} </Text>
        <Text color={pal.tone[t.id] ?? pal.mark[t.id]}>{view[t.id].count}</Text>
      </Text>
    ))

    // Line 1: the counts, then [Open inbox] at the right end. On desktop a native button is taller than
    // a line of text, so the text sits level with its top. Sample counts could pass for real ones, so the demo says so.
    const countLine = (
      <Box flexDirection="row" alignItems="flex-start" gap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">
            {showsDemoNotices ? <Text dimColor>Demo: </Text> : null}
            {counts.length > 0 ? (
              counts.flatMap((p, n) => (n === 0 ? [p] : [<Text dimColor>{DOT}</Text>, p]))
            ) : (
              <Text dimColor>Nothing needs you</Text>
            )}
          </Text>
        </Box>
        {showsDemoNotices ? <Button key="hide-demo" label="Hide demo" onPress={() => void setDemo($, false)} /> : null}
        <Button key="open-inbox" label="Open inbox" onPress={() => void openInbox($)} />
      </Box>
    )
    if (!stop) return countLine

    // A stop draws under the counts, so [Open inbox] stays in place. An API error resumes from
    // [Resume], which keeps its key while it sends, so the desktop app keeps the band's focus.
    const isResumable = stop.kind === 'api-error'
    const notSent = isResumable && resuming?.is === 'refused' ? `Not sent: ${resuming.why}` : ''
    // On desktop, a stop line that wraps pushes [Resume] to the right edge, under [Open inbox], so a refusal takes its own row.
    const isNotSentOwnRow = notSent !== '' && e.surface === 'desktop' && e.props.maxRows > 2
    const fix = isResumable ? '' : stopFix(stop)
    const inlineNotSent = isNotSentOwnRow ? '' : notSent
    const stopLine = (
      <Box flexDirection="row" alignItems="flex-start" gap={1}>
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">
            <Text color="error">Stopped {ago(now - stop.at)}: </Text>
            {stopText(stop)}.{fix ? <Text dimColor> {fix}</Text> : null}
            {inlineNotSent ? <Text color="error"> {inlineNotSent}</Text> : null}
          </Text>
        </Box>
        {isResumable ? (
          <Button
            key="resume"
            label={resuming?.is === 'sending' ? 'Resuming…' : 'Resume'}
            onPress={() => void resume($)}
          />
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {countLine}
        {e.props.maxRows > 1 ? stopLine : null}
        {isNotSentOwnRow ? <Text color="error">{notSent}</Text> : null}
      </Box>
    )
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined) await update($, THEME, () => (typeof r.value === 'string' ? r.value : ''))

    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = elements
    // Desktop draws every Button as a native button, and only clicks reach the pane: no letters, key hints or hidden hotkeys.
    const look = lookOf(e.surface)
    paneLook = look
    // Without a Client, an older desktop engine draws each of these with Buttons instead.
    const hasClient = look === 'desktop' && 'Client' in elements
    // The mobile app draws no text field, so there the typed reply is not offered; nor on desktop without DESKTOP_TYPING.
    const Input = 'Input' in elements && (look === 'terminal' || DESKTOP_TYPING) ? elements.Input : null
    // Narrow, the desktop pane drops closed rows' ages.
    const isNarrowDesktop = look === 'desktop' && e.props.bodyColumns < DESKTOP_WIDE_AT
    // The terminal draws a row's age in its side column, so no line repeats it.
    const isAgeInSide = look === 'terminal'
    const isAgeDropped = isNarrowDesktop || isAgeInSide
    // " · Addressed" wraps as one unit after a title, not with the dot left at a line's end: past its first
    // character, a space becomes a no-break space and an en space a figure space, about as wide and unbreakable.
    const unbroken = (after: string) => after.replace(/(?<=.)[ \u2002]/gs, c => (c === ' ' ? '\u00a0' : '\u2007'))
    // Inline above the prompt, the pane takes its room from the conversation, so
    // it drops the section cards, the tab panels and the blank lines between parts.
    const isInline = e.props.placement === 'inline'
    isInlinePane = isInline
    const blankLine = isInline ? 0 : 1
    // Row spacing by look. A desktop row pads the same open, closed or just closed, so its title stays put when it
    // opens, and its rows sit flush with the Closed fold under them. Desktop's buttons draw their own padding, so a
    // narrower gap than the terminal's two cells keeps a row together.
    const space =
      look === 'desktop'
        ? { rowPad: 2 * DESKTOP_ROW_PAD, settledPad: 2 * DESKTOP_ROW_PAD, buttonGap: 1, isFoldGapped: false }
        : { rowPad: blankLine, settledPad: 0, buttonGap: 2, isFoldGapped: true }
    const [
      { ledger, prViews: prState, lastActions, notes, turns, stop, view, showsDemoNotices, isUnread, now },
      tab,
      selection,
      theme,
      typing,
      unfolded,
      foldHover,
      isKeyListShown,
      optionsShown,
      termProgram,
    ] = await Promise.all([
      drawnState($),
      read($, TAB),
      read($, SELECTION),
      read($, THEME),
      read($, TYPING),
      read($, UNFOLDED),
      read($, FOLD_HOVER),
      read($, IS_KEY_LIST_SHOWN),
      read($, OPTIONS_SHOWN),
      $.env.get('TERM_PROGRAM'),
    ])
    // A hot reload keeps TYPING but empties fieldSeeds, so an open field takes its seed again here.
    if (typing !== null && !fieldSeeds.has(typing)) fieldSeeds.set(typing, (await read($, DRAFTS))[typing] ?? '')
    // A resize rewraps the rows above the open one, which keeps its old offset and slides off the window's top.
    // The scroll waits a moment, so it measures the redraw at the new size.
    const size = isInline ? `${e.props.bodyColumns}x${e.props.scroll.bodyRows}` : null
    if (size !== null && inlineSize !== null && size !== inlineSize) {
      later($, RESIZE_SCROLL_MS, () => scrollToOpenRow($, tab))
    }
    inlineSize = size
    const shownPrs = drawnPrs(prState, ledger.prs, lastActions, now)
    const prViews = shownPrs.map(x => x.pr)
    const pal = paletteFor(theme, look)
    // Text an agent wrote, with its inline markdown drawn as styles. A link draws its label, then its URL, since
    // neither pane documents a Link inside a line of Text.
    const inlineText = (text: string) =>
      parseInline(text).map((s, n) => (
        <Text key={String(n)}>
          <Text
            bold={s.bold}
            italic={s.italic}
            strikethrough={s.strike}
            underline={s.link ? true : undefined}
            // Claude Code's own color for inline code.
            color={s.code ? 'permission' : undefined}
          >
            {s.text}
          </Text>
          {s.link ? <Text color={pal.muted}>{` ${s.link}`}</Text> : null}
        </Text>
      ))
    // `inverse: false` keeps the engine from inverting the line under the pointer inside the panel.
    const raise = {
      dimColor: false,
      backgroundColor: pal.raised,
      inverse: false,
      // A hover prop set to undefined is refused, so the color is left out when the palette has none.
      ...(pal.raisedText ? { color: pal.raisedText } : {}),
    }
    // A tab's half line, ▄ or ▀, raises by its glyph's color.
    const raiseEdge = { dimColor: false, color: pal.raised, inverse: false }

    // One list row's content. Selected, a row shows its context line, its title
    // in full, its body and its keys; otherwise one line: `line`, or the title.
    type Row = {
      id: string
      handle: string
      /** A status color for a marker handle, such as a failing check's ✗. A Button takes no color, so this handle is Text and only the row's text selects it. */
      handleTone?: Tone
      /** A line above the title, open or closed: the row's kind, its age, then `notes`, such as a comment count. */
      head?: { label: string; tone: Tone; age: string; notes?: string }
      title: string
      /** Muted text on the selected title's line, such as an age. */
      titleAfter?: string
      /** When the row was asked or found, for the desktop side column. */
      at?: number
      /** A line under the selected title. */
      subtitle?: JSX.Element
      /**
       * Unselected, the row is one line: `before` muted, `text` as a button that selects the row, then `after`, muted or
       * in a tone, then `age`, which a narrow desktop pane leaves out.
       */
      line?: { before?: string; text: string; after?: string; afterTone?: Tone; age?: string }
      /** Unselected, text that does not fit beside `after` goes on a second line instead of being cut. */
      hasSecondLine?: boolean
      body?: JSX.Element | null
      /** The body cut to `lines` lines of `width` cells, or left out, for an inline pane too short to show the open row whole. */
      clippedBody?: (lines: number, width: number) => JSX.Element | null
      keys: () => KeyAction[]
      /** Actions that talk about the row or drop it, after `keys`: past a muted dot in the terminal, on their own line on desktop. */
      moreKeys?: () => KeyAction[]
      /** Keys the selected row takes without drawing them, as Explain's. */
      hiddenKeys?: () => KeyAction[]
      /** For a row that takes the person's own words: what its field says while empty. */
      typeHint?: string
      /** What sending those words does: closes a question, or hands a task or finding off. */
      /** The row no longer waits on the person, so its group's count leaves it out. Selected, it also shows `note`. */
      fold?: { note?: string }
    }
    // An item's group header says whether it is a question or a task, so the row
    // needs no context line. The recommended answer is marked on its key.
    const itemRow = (r: RowView, item: Item): Row => {
      const asked = item.at === null ? undefined : `${DOT}${ago(now - item.at)}`
      // A task handed to Claude folds, as an answered question closes, until Claude's reply leaves it open.
      const isHandedOff = r.state.is === 'handedOff'

      return {
        id: item.id,
        // Desktop marks only a handed-off item. Its options answer a question, and the group header says the kind.
        handle: isHandedOff ? '✓' : look === 'desktop' ? '' : r.handle,
        handleTone: isHandedOff ? 'done' : undefined,
        ...(isHandedOff ? { fold: {} } : {}),
        title: item.ask,
        titleAfter: asked,
        ...(item.at === null ? {} : { at: item.at }),
        hasSecondLine: item.kind === 'question',
        body: null,
        keys: () => rowKeyActions($, look, r, optionsShown.includes(r.id)).keys,
        moreKeys: () => rowKeyActions($, look, r, optionsShown.includes(r.id)).more,
        hiddenKeys: () => rowKeyActions($, look, r, optionsShown.includes(r.id)).hidden,
        typeHint: item.kind === 'task' ? 'Your reply to Claude' : 'Your answer',
      }
    }
    // A finding's handle is its kind's mark, ▲ or ✦, and its group's title says the kind. Handed to Claude, it
    // folds, as a task does, until Claude's reply leaves it open.
    const findingBody = (detail: string, path: string | null) => (
      <Box flexDirection="column" rowGap={blankLine}>
        <Text wrap="wrap">{inlineText(detail)}</Text>
        {path ? (
          <Text wrap="wrap">
            <Text color={pal.muted}>Relevant file: </Text>
            {/* Claude Code's own color for inline code. */}
            <Text color="permission">{baseName(path)}</Text>
          </Text>
        ) : null}
      </Box>
    )
    const findingRow = (r: RowView, finding: Finding): Row => ({
      id: finding.id,
      at: finding.at,
      ...(r.state.is === 'handedOff'
        ? { handle: '✓', handleTone: 'done' as const, fold: {} }
        : { handle: FINDING_GROUPS[finding.kind].mark, handleTone: FINDING_GROUPS[finding.kind].tone }),
      title: finding.title,
      titleAfter: `${DOT}${ago(now - finding.at)}`,
      line: { text: finding.title },
      body: findingBody(finding.detail, finding.path),
      // The file's line goes first, then the detail, which keeps at least one line while it shows.
      clippedBody: (lines, width) =>
        lines < 1
          ? null
          : findingBody(
              clipToLines(finding.detail, width, Math.max(1, lines - (finding.path && lines > 1 ? 1 : 0))),
              lines > 1 ? finding.path : null,
            ),
      typeHint: 'Your reply to Claude',
      keys: () => rowKeyActions($, look, r, true).keys,
      moreKeys: () => rowKeyActions($, look, r, true).more,
      hiddenKeys: () => rowKeyActions($, look, r, true).hidden,
    })
    const isThreadSent = threadSentIn(lastActions)
    // A PR action labeled "… again" once it was its row's last action, unless its message failed to send.
    const again = (rowId: string, action: PrActionId, label: string) =>
      lastActions[rowId]?.action === action && lastActions[rowId]?.delivery?.state !== 'failed'
        ? `${label} again`
        : label
    const prPress = (p: PrPress) => (press: UiPressArgument) => runPress($, p, press.surface)
    const checkRowBase = (pr: PrView, c: PrCheck): Row => ({
      id: prCheckId(pr, c),
      handle: '✗',
      handleTone: 'error',
      title: c.name,
      line: { text: c.name },
      body: null,
      keys: () => [
        ...[prRetryOf(lastActions[prCheckId(pr, c)], pr.ref, null, c.name)].flatMap(retry =>
          retry
            ? [
                {
                  key: `retry-${pr.ref}-${c.name}`,
                  label: 'Try again',
                  icon: '↻',
                  kind: retry.kind,
                  onPress: prPress(retry.press),
                },
              ]
            : [],
        ),
        {
          key: `fix-${pr.ref}-${c.name}`,
          label: again(prCheckId(pr, c), 'check-fix', 'Fix'),
          isMain: true,
          hotkey: 'a',
          kind: 'handoff',
          onPress: prPress({ action: 'check-fix', ref: pr.ref, check: c.name }),
        },
        {
          key: `log-${pr.ref}-${c.name}`,
          label: 'Open log',
          icon: '↗',
          hotkey: 'o',
          kind: 'local',
          onPress: prPress({ action: 'log', ref: pr.ref, check: c.name }),
        },
      ],
    })
    // The block's "Failing checks" title says the kind, so the row reads as GitHub lists it: "CI / lint", then how
    // long it ran.
    const checkRow = (pr: PrView, c: PrCheck): Row => {
      const ran =
        c.startedAt !== undefined && c.finishedAt !== undefined
          ? `Failed after ${took(c.finishedAt - c.startedAt)}`
          : 'Failed'
      return {
        ...checkRowBase(pr, c),
        ...(c.finishedAt !== undefined ? { at: c.finishedAt } : {}),
        line: { ...(c.workflow ? { before: `${c.workflow} / ` } : {}), text: c.name, after: ran },
        subtitle: <Text color={pal.muted}>{c.workflow ? `${c.workflow}${DOT}${ran}` : ran}</Text>,
      }
    }
    const threadRow = (pr: PrView, t: PrThread): Row => {
      const id = prThreadId(pr, t)
      // Open, the row adds where the thread sits and the latest reply under the comment its title already shows.
      const { head, rest } = commentParts(t.body)
      const where = (
        <Text color={pal.muted} wrap="wrap">
          {/* As Open comment does, it opens the latest reply, else the first comment. */}
          <Link href={t.reply?.url || t.url}>
            <Text underline>{threadWhere(t)}</Text>
          </Link>
          {DOT}@{t.author}
        </Text>
      )
      const comment = (
        <Box flexDirection="column">
          {rest ? <Markdown text={clipLabel(rest, 1200)} /> : null}
          {where}
          {t.reply ? (
            <Markdown text={`**@${t.reply.author}:** ${clipLabel(readableComment(t.reply.body), 1200)}`} />
          ) : null}
        </Box>
      )
      const replyText = t.reply ? `@${t.reply.author}: ${readableComment(t.reply.body)}` : ''
      // The where line stays, the comment takes the lines it can, and the reply the lines left. Clipped, both draw as
      // plain text, since a cut can split their Markdown.
      const clippedComment = (lines: number, width: number) => {
        if (lines < 1) return null
        const restLines = rest ? lineCount(rest, width) : 0
        const replyLines = replyText ? lineCount(replyText, width) : 0
        if (restLines + 1 + replyLines <= lines) return comment
        const restShown = Math.min(restLines, lines - 1)
        const replyShown = Math.min(replyLines, lines - 1 - restShown)

        return (
          <Box flexDirection="column">
            {rest && restShown > 0 ? <Text wrap="wrap">{inlineText(clipToLines(rest, width, restShown))}</Text> : null}
            {where}
            {replyShown > 0 ? <Text wrap="wrap">{inlineText(clipToLines(replyText, width, replyShown))}</Text> : null}
          </Box>
        )
      }
      // Sent to Claude, the thread folds to the first line of its latest comment,
      // until a comment newer than the send arrives. So does one on lines a later
      // commit changed, but with no ✓: nothing says the change fixed it.
      const isSent = isThreadSent(pr, t)
      const isChanged = !isSent && t.isLinesChanged
      const retry = prRetryOf(lastActions[id], pr.ref, t.id)

      return {
        id,
        handle: isSent ? '✓' : '◦',
        handleTone: isSent ? 'done' : undefined,
        ...(isSent || isChanged
          ? { fold: t.isLinesChanged ? { note: `Lines changed since this comment${DOT}still open on GitHub` } : {} }
          : {}),
        // The block's "Review threads" title says the kind. The first comment, which asks for the change, is the
        // title open or closed, and the line under it says where it sits and who asked, or the latest reply.
        title: clipLabel(head, THREAD_TITLE_CHARS),
        ...(t.at === null ? {} : { at: t.at }),
        line: {
          before: '',
          text: commentLine(t.body),
          after: [
            threadWhere(t, baseName(t.path)),
            isChanged ? 'Lines changed' : '',
            t.reply ? `@${t.reply.author}: ${commentLine(t.reply.body)}` : `@${t.author}`,
          ]
            .filter(Boolean)
            .join(DOT),
        },
        body: comment,
        clippedBody: clippedComment,
        keys: () => [
          ...(retry
            ? [
                {
                  key: `retry-${t.id}`,
                  label: 'Try again',
                  icon: '↻',
                  kind: retry.kind,
                  onPress: prPress(retry.press),
                },
              ]
            : []),
          {
            key: `address-${t.id}`,
            label: again(id, 'thread-address', 'Address'),
            isMain: true,
            hotkey: 'a',
            kind: 'handoff',
            onPress: prPress({ action: 'thread-address', ref: pr.ref, thread: t.id }),
          },
          {
            key: `draft-${t.id}`,
            label: again(id, 'thread-draft', 'Draft reply'),
            hotkey: 'r',
            kind: 'talk',
            onPress: prPress({ action: 'thread-draft', ref: pr.ref, thread: t.id }),
          },
          {
            key: `open-${t.id}`,
            label: 'Open comment',
            icon: '↗',
            hotkey: 'o',
            kind: 'local',
            onPress: prPress({ action: 'thread-open', ref: pr.ref, thread: t.id }),
          },
        ],
        moreKeys: () => [
          {
            key: `discuss-${t.id}`,
            label: again(id, 'thread-discuss', 'Discuss'),
            hotkey: 'e',
            kind: 'talk',
            onPress: prPress({ action: 'thread-discuss', ref: pr.ref, thread: t.id }),
          },
        ],
      }
    }

    type Entry = DrawnEntry<Row>
    // Each list's entries, and each tab's rows in order: the cursor, the counts and the drawing all read these.
    // The pane draws every row the view lists as just closed.
    const lists = drawnLists(
      view,
      () => true,
      r => (r.item ? itemRow(r, r.item) : r.finding ? findingRow(r, r.finding) : null),
    )
    const needsYouGroups = NEEDS_YOU_GROUPS.map(g => ({ ...g, entries: lists[g.list], rows: rowsIn(lists[g.list]) }))
    const findingEntries = lists.findings
    // A PR dismissed moments ago draws settled, with no rows.
    const prGroups = shownPrs
      .map(({ pr, isSettled }) => ({
        pr,
        isSettled,
        checks: isSettled ? [] : failingChecks(pr).map(c => checkRow(pr, c)),
        threads: isSettled ? [] : waitingThreads(pr).map(t => threadRow(pr, t)),
      }))
      .map(g => ({ ...g, rows: [...g.threads, ...g.checks] }))
    const rows: Record<Tab, Row[]> = {
      needsYou: lists.byTab.needsYou,
      findings: lists.byTab.findings,
      prs: prGroups.flatMap(g => g.rows),
    }
    // What waits on the person: rows, or on the PRs tab, PRs. A row handed to Claude waits on Claude.
    const tabCounts: Record<Tab, number> = {
      needsYou: view.needsYou.count,
      findings: view.findings.count,
      prs: prGroups.filter(g => !g.isSettled && prNeedsYou(g.pr, isThreadSent)).length,
    }
    const ids = rows[tab].map(r => r.id)
    const indexOf = new Map(ids.map((id, n) => [id, n]))
    const cursor = selection[tab]
    const settledIds = new Set(settledRowIds(allRows(view)))
    const top = firstWaiting(
      tabWaits(
        tab,
        view,
        shownPrs.filter(x => !x.isSettled).map(x => x.pr),
        lastActions,
      ),
    )
    const at = selectedIndex(ids, cursor, top, id => settledIds.has(id))
    // The open row's buttons ignore clicks for a moment after it opens, and draw dim meanwhile.
    const isOpenGuarded = isGuarded(cursor.openedAt, now)

    // A Button draws its hotkey in the theme's accent, which Claude Code's light
    // theme draws at 2.9:1 on the selected row. So a key's letter is Text in the
    // palette's color, its label a Button, and the key itself a hidden Button.
    // Both invert while the pointer is over either, so the letter lights with its label.
    // A hover cannot name the terminal's default color, which a Button's label
    // inverts, so the letter and the label both invert the muted color to match.
    // An action past the lettered ones, or one that only changes the view, has no key and draws its label alone.
    // While the open row is guarded, both draw dim and a click does nothing. Its key, a hidden Button, works at once.
    // On desktop an action is its native button alone. The recommended option's label ends "(recommended)" in the
    // terminal and desktop looks. A plain terminal Button ignores `variant`, so there the words are the only mark.
    // Desktop also draws the option as its primary button.
    const shownLabel = (a: Pick<KeyAction, 'label' | 'variant'>) =>
      a.variant === 'primary' ? `${a.label} (recommended)` : a.label
    const desktopLabel = (a: Pick<KeyAction, 'label' | 'variant' | 'icon'>) =>
      a.icon ? `${a.icon} ${shownLabel(a)}` : shownLabel(a)
    // On desktop a follow-up (`isFollowUp`) draws as plain text, so the row's answers and main action stand out.
    const keyedButton =
      (rowId: string, isFollowUp = false) =>
      ({ hotkey, kind: _kind, isMain, icon, ...action }: KeyAction) => {
        const { label: _label, ...unlabeled } = action

        return look === 'desktop' ? (
          <Button
            {...action}
            {...(isFollowUp ? { plain: true } : isMain ? { variant: 'primary' as const } : {})}
            label={desktopLabel({ ...action, ...(icon ? { icon } : {}) })}
            {...(isOpenGuarded ? { dimColor: true } : {})}
            onPress={press => unlessGuarded($, rowId, press, action.onPress)}
          />
        ) : (
          // The key letter is inside the Button, so the focus and hover highlights take it with the label.
          <Box key={`keyed-${action.key}`} flexDirection="row">
            <Button
              plain
              {...unlabeled}
              {...(isOpenGuarded ? { dimColor: true } : {})}
              hover={{ color: pal.muted, inverse: true }}
              onPress={press => unlessGuarded($, rowId, press, action.onPress)}
            >
              {hotkey ? (
                <Text color={pal.key} dimColor={isOpenGuarded} hover={{ color: pal.muted, inverse: true }}>
                  {hotkey}
                </Text>
              ) : null}
              {hotkey ? `: ${shownLabel(action)}` : shownLabel(action)}
            </Button>
          </Box>
        )
      }
    // On desktop, the follow-ups as plain text in a Client, which posts the key clicked.
    // Emptied here, after the drawing's reads, so a click that lands while they run still finds the last presses.
    followUpPresses.clear()
    const followUpLinks = (rowId: string, more: KeyAction[]) => {
      if (!hasClient) return null
      for (const a of more) followUpPresses.set(a.key, press => unlessGuarded($, rowId, press, a.onPress))
      const props: LinksProps = {
        links: more.map(a => {
          const label = desktopLabel(a)
          // A fractional width, not one rounded up to whole cells, so the gap after each link looks the same.
          return { key: a.key, label, width: label.length / DESKTOP_CHARS_PER_CELL + 0.5 }
        }),
        gap: 1.5,
        isGuarded: isOpenGuarded,
        colors: { muted: pal.muted, hover: null },
      }

      return <elements.Client key={`links-${rowId}`} module="./links-client.tsx" props={props} />
    }
    // The open row's actions. In the terminal its other actions can follow its main ones after a muted dot.
    const keyRow = (rowId: string, keys: KeyAction[], more: KeyAction[] = []) => (
      <Box
        flexDirection="row"
        flexWrap="wrap"
        alignItems="center"
        columnGap={space.buttonGap}
        rowGap={look === 'desktop' ? 1 : 0}
      >
        {/* Desktop leads with the main action, so a task's Done keeps its place whatever step button follows. */}
        {(look === 'desktop' ? [...keys.filter(k => k.isMain), ...keys.filter(k => !k.isMain)] : keys).map(
          keyedButton(rowId),
        )}
        {look === 'terminal' && keys.length > 0 && more.length > 0 ? <Text color={pal.muted}>·</Text> : null}
        {more.length > 0 ? (followUpLinks(rowId, more) ?? more.map(keyedButton(rowId, true))) : null}
      </Box>
    )
    // The Buttons that take the pane's keys, drawn in a hidden Box.
    const keyBindings = (keys: KeyAction[], suffix = '') =>
      keys.flatMap(({ key, hotkey, kind: _kind, isMain: _isMain, icon: _icon, ...k }) =>
        hotkey ? [<Button key={`${key}${suffix}`} plain hotkey={hotkey} {...k} label={shownLabel(k)} />] : [],
      )
    // In the terminal, a selected row's secondary keys share its key row when they fit, and
    // otherwise take a line of their own rather than wrap mid-row. A key draws
    // "key: label", and keyRow puts 2 columns between keys and the dot.
    const keysWidth = (keys: KeyAction[], more: KeyAction[]) => {
      const all = [...keys, ...more]
      const dot = keys.length > 0 && more.length > 0 ? 3 : 0

      return (
        all.reduce((w, k) => w + (k.hotkey ? k.hotkey.length + 2 : 0) + shownLabel(k).length, 0) +
        2 * Math.max(0, all.length - 1) +
        dot
      )
    }
    // The lines a selected terminal row's keys take: one when they fit, else the main keys and the others each wrap.
    const keyLines = (keys: KeyAction[], more: KeyAction[], width: number) => {
      if (keysWidth(keys, more) <= width) return 1
      const wrappedLines = (actions: KeyAction[]) => {
        let lines = 0
        let used = 0
        for (const k of actions) {
          const w = (k.hotkey ? k.hotkey.length + 2 : 0) + shownLabel(k).length
          if (used > 0 && used + 2 + w <= width) used += 2 + w
          else {
            lines++
            used = w
          }
        }
        return lines
      }

      return wrappedLines(keys) + wrappedLines(more)
    }
    // A typed reply needs a text field, so it is left out where there is none.
    const pressable = (keys: KeyAction[]) => keys.filter(k => Input || !k.key.startsWith('typekey-'))
    // Under a just-closed row, a thin bar that empties as its time in place runs out.
    // ─ is a light line across a cell and ╴ across its left half, so the bar shrinks by half cells.
    const leaveBar = (at: number) => {
      if (look !== 'terminal') return null
      const halves = Math.ceil((Math.max(0, SETTLED_MS - (now - at)) / SETTLED_MS) * LEAVE_BAR_STEPS)

      return halves > 0 ? (
        <Text color={pal.muted}>{'─'.repeat(Math.floor(halves / 2)) + (halves % 2 ? '╴' : '')}</Text>
      ) : null
    }
    // The selected row's keys, for both the key row it draws and the hidden bindings.
    const rowActions = (row: Row): { keys: KeyAction[]; more: KeyAction[]; hidden: KeyAction[] } => {
      if (Input && row.typeHint && typing === row.id) return { keys: [], more: [], hidden: [] }

      return {
        keys: pressable(row.keys()),
        more: pressable(row.moreKeys?.() ?? []),
        hidden: row.hiddenKeys?.() ?? [],
      }
    }
    // Under the open field: Send sends the row's draft, and Cancel closes the field and keeps the draft.
    const fieldActions = (row: Row): KeyAction[] => [
      {
        key: `send-${row.id}`,
        label: 'Send',
        kind: 'handoff',
        onPress: press => sendDraft($, row.id, press.surface),
      },
      {
        key: `cancel-${row.id}`,
        label: 'Cancel',
        kind: 'view',
        onPress: () => void update($, TYPING, t => (t === row.id ? null : t)),
      },
    ]
    // A last action reads "✓ Discuss · 1m ago", or "Queued: Discuss · 1m ago". A row whose own mark is a ✓
    // leaves out the second one. A note and a Local result read alone, with no age. A failure is red.
    const feedbackLabel = (id: string, row?: Row) => {
      const f = feedbackOf(id, lastActions[id], notes[id], turns, now)
      if (!f) return null

      return hasAge(f)
        ? {
            text: f.is === 'done' && row?.handle === '✓' ? f.label : feedbackText(f, look),
            age: ago(now - f.at),
            isFailure: false,
          }
        : { text: feedbackText(f, look), age: '', isFailure: isFailure(f) }
    }
    const lastActionText = (id: string) => {
      const f = feedbackLabel(id)

      return f ? { text: [f.text, f.age].filter(Boolean).join(DOT), isFailure: f.isFailure } : null
    }
    // A press that went through, or waits in the queue, takes the place of the row's age on its top line, open or
    // closed: the head line, or the title's line. A note or failure reads under the body instead. A narrow desktop
    // pane drops the age, not the action.
    const pressedAge = (row: Row) => {
      const f = feedbackLabel(row.id, row)

      return f?.age ? `${DOT}${[f.text, isAgeDropped ? '' : f.age].filter(Boolean).join(' ')}` : null
    }
    const headOf = (row: Row, head: NonNullable<Row['head']>) => ({
      ...head,
      age: `${pressedAge(row) ?? (isAgeInSide ? '' : head.age)}${head.notes ?? ''}`,
    })
    // A section's children hang from its title like a directory listing. A
    // child's row has a 1-column bar and a blank column, 3 columns for the tree,
    // 3 for its marker, then its text. `branch` draws the tree: ├─ on the child's first line, or
    // └─ on the last child's, then │ below while siblings follow; `pass` is │
    // throughout, for a block between a title and its children. The lines sit
    // in an absolute Box that spans the row, however it wraps, and the row clips
    // the rest. The row clips, not this Box: once its row scrolled out of view,
    // Claude Code drew lines this Box clipped elsewhere in the pane (anthropics/claude-code#100030).
    // Desktop draws no tree: its lines differ in height, so stacked glyphs break into separate bars.
    const branch = (pos: TreePos, lead = 0, left = TREE_LINE_AT, color = pal.line) =>
      look === 'desktop' ? null : (
        <Box position="absolute" top={0} bottom={0} left={left} width={2}>
          <Text color={color}>{treeText(pos, lead)}</Text>
        </Box>
      )
    // A row with no marker, such as a group's empty line, starts its text right after the tree.
    // A row at depth 1 hangs from a tree under the marker column, as a group's closed items do.
    // The columns a row draws at: one set on desktop, the tree's or the flat ones in the terminal.
    const columnsFor = (tree?: TreePos | null, extra = 0) => {
      const base = look === 'desktop' ? ROW_COLUMNS.desktop : tree ? ROW_COLUMNS.tree : ROW_COLUMNS.flat
      return { ...base, textAt: base.textAt + extra }
    }
    // A number from 10 up, as "10)", is a column wider than the mark column, so every question then starts its text
    // a column later and the list stays in line.
    const wideQuestions = view.needsYou.questions.some(r => r.handle.length > 2)
      ? new Set(view.needsYou.questions.map(r => r.id))
      : new Set<string>()
    const markExtra = (id: string) => (wideQuestions.has(id) ? 1 : 0)
    // A tree row's mark column, which a nested row's lead also steps by.
    const markColumns = look === 'desktop' ? ROW_COLUMNS.desktop : ROW_COLUMNS.tree
    const markWidth = markColumns.textAt - markColumns.handleAt
    const treeRow = (
      pos: TreePos | null,
      marker: JSX.Element | null,
      content: JSX.Element,
      key?: string,
      depth = 0,
      lead = markColumns.handleAt + markWidth * depth,
      extra = 0,
    ) => (
      <Box key={key} flexDirection="row" alignItems="flex-start" overflow="hidden">
        <Box width={lead} flexShrink={0} />
        {marker ? (
          <Box width={markWidth + extra} flexShrink={0}>
            {marker}
          </Box>
        ) : null}
        <Box flexDirection="column" flexShrink={1} flexGrow={1} paddingRight={1}>
          {content}
        </Box>
        {pos ? branch(pos, 0, TREE_LINE_AT + markWidth * depth) : null}
      </Box>
    )
    const childPos = (n: number, count: number): TreePos => (n === count - 1 ? 'last' : 'mid')
    // A list's rows with a divider between each two. It starts where the rows'
    // text starts and runs to the pane's edge; in a section, the tree's │ passes it.
    // A divider line from `inset` columns in to the pane's edge.
    const rule = (inset: number) => (
      <Text color={pal.divider}>{'─'.repeat(Math.max(0, e.props.bodyColumns - inset))}</Text>
    )
    // Desktop draws text in a proportional font, where a run of ─ sized in cells overflows the
    // row and wraps into a second line, so there the rows sit flush and each pads itself.
    // `isBarred(n)` says element n draws a just-closed row's draining bar, which stands in for the rule after it:
    // a rule under the bar would draw two dashed lines in a row.
    // `extra` moves the rules with a list whose text starts later, as numbers from 10 up make the questions' do.
    const divided = (
      rowEls: JSX.Element[],
      group: string,
      isTree: boolean,
      isBarred = (_n: number) => false,
      extra = 0,
    ) =>
      rowEls.flatMap((el, n) =>
        n === 0 || isInline || look === 'desktop' || isBarred(n - 1)
          ? [el]
          : [
              isTree ? (
                <Box key={`divider-${group}-${n}`} flexDirection="row">
                  <Box width={TREE_LINE_AT} flexShrink={0} />
                  <Box width={ROW_COLUMNS.tree.textAt - TREE_LINE_AT + extra} flexShrink={0}>
                    <Text color={pal.line}>│</Text>
                  </Box>
                  {rule(ROW_COLUMNS.tree.textAt + 2 + extra)}
                </Box>
              ) : (
                <Box key={`divider-${group}-${n}`} paddingLeft={5}>
                  {rule(7)}
                </Box>
              ),
              el,
            ],
      )
    // A desktop native button is assumed to draw about 2 columns wider than its label.
    const buttonFrame = look === 'desktop' ? 2 : 0
    // A closed row's one line: `before` muted, the title, then `after`. A row's last action takes the place of
    // its age, as "✓ Discuss 1m ago". A narrow desktop pane drops the age, not the action.
    const closedLine = (row: Row) => {
      const plain = row.line ?? { text: row.title, age: row.titleAfter }
      const f = feedbackLabel(row.id, row)
      // A head line already shows the press.
      if (f && !(row.head && f.age))
        return {
          ...plain,
          after: `${DOT}${[f.text, isAgeDropped ? '' : f.age].filter(Boolean).join(' ')}`,
          afterTone: f.isFailure ? ('error' as const) : undefined,
        }

      return { ...plain, after: [plain.after, isAgeDropped ? '' : plain.age].filter(Boolean).join('') || undefined }
    }
    // The selected row gets a blue background, or a bar where the palette has
    // no selection color, and reads top to bottom:
    // context line, title, body, keys. In the docked pane a blank line sets each
    // part off. In the terminal the handle is a Button that selects the row. On desktop the whole row is a
    // Client that does, or without one, the title button.
    // A Button label does not wrap or truncate, so the clickable text is clipped
    // to what fits beside the handle and the row's other text, less a desktop button's frame.
    // A row with a second line breaks its text at a space before `after`, which
    // stays on the first line, and clips the rest to the second.
    // A row's head: its label in its tone, then its age.
    const headLine = (head: NonNullable<Row['head']>, ageColor: string) => (
      <Text wrap="truncate-end">
        <Text color={pal.tone[head.tone] ?? pal.mark[head.tone]}>{head.label}</Text>
        {head.age ? <Text color={ageColor}>{head.age}</Text> : null}
      </Text>
    )
    const unselectedLine = (row: Row, onPress: (press: UiPressArgument) => void, inset: number) => {
      const line = closedLine(row)
      const before = line.before?.length ?? 0
      const side = isAgeInSide ? TERMINAL_SIDE_CELLS : 0
      const width = e.props.bodyColumns - 3 - inset - side - before
      const perCell = look === 'desktop' ? DESKTOP_CHARS_PER_CELL : 1
      // `before` is text, so it counts in characters, as the title does.
      const budget = Math.floor((e.props.bodyColumns - 3 - inset - side - buttonFrame) * perCell) - before
      // In the terminal a row's own `after`, such as who asked, is its muted meta line. A press's, which starts with
      // the dot, stays on the title's line while the title fits beside it, and otherwise takes the meta line too.
      const isAfterCutting = line.after !== undefined && line.text.trim().length > budget - line.after.length
      const meta =
        look === 'terminal' && line.after && (!LEADING_DOT.test(line.after) || isAfterCutting)
          ? line.after.replace(LEADING_DOT, '')
          : null
      const room = Math.max(12, budget - (meta ? 0 : (line.after?.length ?? 0)))
      const text = line.text.trim()
      const space = text.lastIndexOf(' ', room)
      // Desktop cuts the title to one native button, rather than draw two.
      const isWrapped = look === 'terminal' && row.hasSecondLine === true && text.length > room && space > 0
      const first = isWrapped ? text.slice(0, space) : clipLabel(text, room)
      const second = isWrapped ? clipLabel(text.slice(space + 1), Math.max(12, width)) : null
      // Desktop wraps a long `after` under the title, so it is cut to the room the title leaves.
      const afterRoom = budget - first.length
      const after = meta
        ? undefined
        : look === 'desktop' && line.after && line.after.length > afterRoom
          ? afterRoom >= 2
            ? clipLabel(line.after, afterRoom)
            : undefined
          : line.after
      // The two lines are two Buttons. One hover group inverts both under the pointer, so they read as one.
      const hover = second ? { hover: { scope: `title-${row.id}`.slice(0, 64), inverse: true } } : {}

      return (
        <Box flexDirection="column">
          {row.head ? headLine(headOf(row, row.head), pal.age) : null}
          {/* Only `after` shrinks when the line is too long: a shrunk `before` would wrap mid-path. */}
          <Box flexDirection="row">
            {line.before ? (
              <Box flexShrink={0}>
                <Text color={pal.muted}>{line.before}</Text>
              </Box>
            ) : null}
            <Box flexShrink={0}>
              <Button plain key={`title-${row.id}`} label={first} {...hover} onPress={onPress} />
            </Box>
            {after ? (
              <Text wrap="truncate-end" color={line.afterTone ? pal.tone[line.afterTone] : pal.muted}>
                {after}
              </Text>
            ) : null}
          </Box>
          {second ? (
            <Box paddingLeft={line.before?.length ?? 0}>
              <Button plain key={`title-${row.id}-2`} label={second} {...hover} onPress={onPress} />
            </Box>
          ) : null}
          {meta ? (
            <Text wrap="truncate-end" color={line.afterTone ? pal.tone[line.afterTone] : pal.muted}>
              {meta}
            </Text>
          ) : null}
        </Box>
      )
    }
    // A closed desktop row drawn by its Client, at the columns listRow draws an open row's handle and text.
    // The desktop side column's age: the row's last action's, or when it was asked or found.
    // On desktop a row's toned mark, and its kind's label when the head shares the mark's tone, draw as one Svg in
    // the shared tones. Without Svg, they stay Text in the palette's theme keys.
    const ToneSvg = look === 'desktop' && 'Svg' in elements ? elements.Svg : null
    const isHeadToned = (row: Row) => ToneSvg !== null && !!row.handle && row.head?.tone === row.handleTone
    const toned = (row: Row) => {
      if (ToneSvg === null || !row.handle || !row.handleTone) return null
      const label = isHeadToned(row) ? (row.head?.label ?? '') : ''
      const cells = label ? 2 + labelCells(label) : 1
      return (
        <Box width={cells} height={1} flexShrink={0}>
          <ToneSvg
            source={toneSvg(row.handleTone, row.handle, label, cells)}
            alt={label ? `${row.handle} ${label}` : row.handle}
            width={cells * DESKTOP_CELL_PT}
            height={DESKTOP_LINE_PT}
          />
        </Box>
      )
    }
    const sideAge = (row: Row) => {
      const f = feedbackOf(row.id, lastActions[row.id], notes[row.id], turns, now)
      const at = f && hasAge(f) ? f.at : row.at
      return at === undefined ? '' : shortAgo(now - at)
    }
    // A closed desktop row drawn by its Client, in the same frame as the pane's other lines.
    const rowClientProps = (row: Row): RowProps => {
      const f = feedbackLabel(row.id, row)
      const text = row.line?.text ?? row.title

      return {
        markCells: DESKTOP_MARK_CELLS + markExtra(row.id),
        sideCells: DESKTOP_SIDE_CELLS,
        before: row.line?.before ?? '',
        title: text.trim(),
        after: f?.age ? f.text : (row.line?.after ?? '').replace(LEADING_DOT, '').trim(),
        side: sideAge(row),
        // The hooks module draws a toned head's label in the mark's Svg, so the Client only holds its line.
        head: row.head
          ? isHeadToned(row)
            ? { label: '\u00a0', color: null }
            : { label: row.head.label, color: pal.tone[row.head.tone] ?? pal.mark[row.head.tone] }
          : null,
        padY: DESKTOP_ROW_PAD,
        maxLines: row.hasSecondLine ? 4 : 2,
        charsPerCell: DESKTOP_CLIP_CHARS_PER_CELL,
        // The list pads the pane by a column on each side.
        fallbackColumns: e.props.bodyColumns - 2,
        colors: {
          muted: pal.muted,
          after: f?.isFailure ? (pal.tone.error ?? null) : pal.muted,
          afterHover: f?.isFailure ? (pal.tone.error ?? null) : pal.muted,
          side: pal.age,
          hover: pal.raised,
          hoverText: pal.raisedText ?? null,
          pressed: pal.selection ?? pal.raised,
        },
      }
    }
    // A desktop list line: the mark column, the text, and the side column for the age or Undo. Each line is a
    // rounded frame with a transparent border, as the row Client draws its own, so every line's text starts at the
    // same column and a fill rounds without moving it.
    const desktopFrame = ({
      key,
      mark = null,
      side = null,
      fill,
      padY = space.rowPad,
      isCentered = false,
      indent = 0,
      isMarkHung = true,
      markCells = DESKTOP_MARK_CELLS,
      gapY = 0,
      children,
    }: {
      key?: string
      mark?: JSX.Element | null
      side?: JSX.Element | null
      fill?: string | undefined
      padY?: number
      /** Centers the parts on each other, for a one-line row whose side is taller than its text, as Undo is. */
      isCentered?: boolean
      /** Columns before the mark, for a line nested under another. */
      indent?: number
      /** Hangs the mark a column left, into the frame's inset. Unhung, the mark starts at `indent` and a column parts it from the text. */
      isMarkHung?: boolean
      markCells?: number
      /** Space above and below the frame, in the hooks tree's half lines. */
      gapY?: number
      children: JSX.Element | (JSX.Element | null)[]
    }) => (
      <Box
        key={key}
        flexDirection="row"
        alignItems={isCentered ? 'center' : 'flex-start'}
        marginY={gapY}
        borderStyle="single"
        borderColor="#0000"
        paddingY={padY}
        {...(fill ? { backgroundColor: fill } : {})}
      >
        {/* A hung mark sits a column left, in the frame's inset, so a full column parts it from the text. Centered,
            the column is one line tall, so it centers on the text's line: with no height it would center at the
            row's middle and the mark would hang below the text. */}
        <Box
          width={indent + markCells + (isMarkHung ? 0 : 1)}
          {...(isCentered ? { height: 1 } : {})}
          flexShrink={0}
          paddingLeft={indent}
        >
          {mark ? (
            <Box position="absolute" top={0} left={isMarkHung ? indent - 1 : indent}>
              {mark}
            </Box>
          ) : null}
        </Box>
        <Box flexDirection="column" flexShrink={1} flexGrow={1}>
          {children}
        </Box>
        <Box minWidth={DESKTOP_SIDE_CELLS} flexShrink={0} flexDirection="row" justifyContent="flex-end" paddingLeft={1}>
          {side}
        </Box>
      </Box>
    )
    // `tree` places the row as a section's child; without it, as in Findings, the
    // handle sits in the 4 columns after the bar.
    // A selected terminal row's first line, with its age at the right. Its keys below take the full width.
    const withSideAge = (row: Row, line: JSX.Element) =>
      isAgeInSide ? (
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            {line}
          </Box>
          <Box width={TERMINAL_SIDE_CELLS - 1} flexShrink={0} justifyContent="flex-end">
            <Text color={pal.age}>{sideAge(row)}</Text>
          </Box>
        </Box>
      ) : (
        line
      )
    const listRow = (row: Row, tree?: TreePos) => {
      const columns = columnsFor(tree, markExtra(row.id))
      const index = indexOf.get(row.id) ?? -1
      const isSelected = index === at
      // On desktop a Client takes a click on every cell of the row, where a Button takes one only on its label.
      // Without one, the row's title is a Button.
      if (!isSelected && hasClient)
        return (
          <Box key={`row-${row.id}`} flexDirection="row" overflow="hidden">
            {/* A Client clips its frame's inset, so the mark hangs there from here, at the frame's own spot. A toned
                mark and the kind's label are an Svg, drawn first and under the Client, which takes the clicks. */}
            {row.handle ? (
              <Box
                position="absolute"
                top={0}
                left={0}
                paddingLeft={(FRAME_INSET_PT - DESKTOP_CELL_PT) / DESKTOP_CELL_PT}
                paddingTop={space.rowPad}
              >
                {toned(row) ?? <Text color={row.handleTone ? pal.mark[row.handleTone] : undefined}>{row.handle}</Text>}
              </Box>
            ) : null}
            <Box position="relative" width="100%">
              <elements.Client
                key={`select-${row.id}`}
                module="./row-client.tsx"
                width="100%"
                props={rowClientProps(row)}
              />
            </Box>
          </Box>
        )
      const { keys, more } = isSelected ? rowActions(row) : { keys: [], more: [] }
      const isTyping = Input !== null && !!row.typeHint && typing === row.id
      const field =
        Input && isTyping ? (
          <Input
            key={`type-${row.id}`}
            placeholder={row.typeHint}
            {...(fieldSeeds.get(row.id) ? { value: fieldSeeds.get(row.id) } : {})}
            submitLabel={look === 'desktop' ? 'Send' : 'send'}
            autoFocus
            onInput={(value: string) => void update($, DRAFTS, d => ({ ...d, [row.id]: value }))}
            onSubmit={(value: string, e) => sendTyped($, row.id, value, e.surface)}
          />
        ) : null
      const f = feedbackLabel(row.id, row)
      const titleAfter = (row.head ? null : pressedAge(row)) ?? (isAgeInSide ? undefined : row.titleAfter)
      const status = [
        ...(row.fold?.note ? [{ text: row.fold.note, color: pal.muted }] : []),
        ...(f && !f.age ? [{ text: f.text, color: f.isFailure ? pal.tone.error : pal.muted }] : []),
      ]

      // Inline, the pane's window can be shorter than the open row, which would hide its keys. The open row scrolls to
      // the window's top (scrollToRow), so the body gives up lines until the row's own lines fit the window.
      // The list's side padding and the row's right padding take 3 columns.
      const textWidth = e.props.bodyColumns - 3 - columns.textAt
      const bodyLines =
        isSelected && isInline && look === 'terminal' && row.clippedBody
          ? e.props.scroll.bodyRows -
            2 * space.rowPad -
            lineCount(`${row.title}${titleAfter ?? ''}`, textWidth - TERMINAL_SIDE_CELLS) -
            status.length -
            keyLines(keys, more, textWidth)
          : null
      const body =
        bodyLines !== null && row.clippedBody && row.body ? row.clippedBody(bodyLines, textWidth) : (row.body ?? null)
      const keysBlock = (
        <Box flexDirection="column" marginTop={blankLine}>
          {isTyping ? (
            look === 'desktop' ? (
              <Box flexDirection="row" alignItems="center" columnGap={space.buttonGap}>
                <Box flexShrink={1}>{field}</Box>
                {/* The desktop Input supplies its own Send button. */}
                {keyRow(
                  row.id,
                  fieldActions(row).filter(a => !a.key.startsWith('send-')),
                )}
              </Box>
            ) : (
              [field, keyRow(row.id, fieldActions(row))]
            )
          ) : look === 'desktop' || keysWidth(keys, more) <= textWidth ? (
            keyRow(row.id, keys, more)
          ) : (
            [keyRow(row.id, keys), keyRow(row.id, more)]
          )}
        </Box>
      )
      // The `view-` Box is what select() scrolls into view. Drawn on the selected row alone, so the key exists only
      // once that row has redrawn expanded.
      if (look === 'desktop' && isSelected)
        return desktopFrame({
          key: `row-${row.id}`,
          markCells: DESKTOP_MARK_CELLS + markExtra(row.id),
          mark:
            toned(row) ??
            (row.handleTone ? <Text color={pal.mark[row.handleTone]}>{row.handle}</Text> : <Text>{row.handle}</Text>),
          side: <Text color={pal.age}>{sideAge(row)}</Text>,
          fill: pal.selection,
          // A rounded fill cannot square one edge, so the selected row keeps 3 pt from its neighbors, whose hover
          // fill would otherwise meet its own.
          gapY: (2 * SELECTED_GAP_PT) / DESKTOP_LINE_PT,
          children: [
            <Box key={`view-${row.id}`} position="absolute" top={0} bottom={0} left={0} width={1} />,
            row.head && !isHeadToned(row) ? (
              <Text wrap="truncate-end" color={pal.tone[row.head.tone] ?? pal.mark[row.head.tone]}>
                {row.head.label}
              </Text>
            ) : row.head ? (
              // The toned mark's Svg draws the label too, so this line only holds its place.
              <Text> </Text>
            ) : null,
            <Text wrap="wrap">
              <Text bold>{row.title}</Text>
              {f?.age ? <Text color={pal.muted}>{unbroken(`${DOT}${f.text}`)}</Text> : null}
            </Text>,
            row.subtitle ?? null,
            row.body ? <Box marginTop={blankLine}>{row.body}</Box> : null,
            status.length > 0 ? (
              <Box flexDirection="column" marginTop={blankLine}>
                {status.map(st => (
                  <Text color={st.color} wrap="wrap">
                    {st.text}
                  </Text>
                ))}
              </Box>
            ) : null,
            keysBlock,
          ],
        })

      return (
        <Box
          key={`row-${row.id}`}
          flexDirection="row"
          alignItems="flex-start"
          overflow="hidden"
          backgroundColor={isSelected ? pal.selection : undefined}
        >
          <Box width={columns.lead} flexShrink={0} />
          <Box
            width={columns.textAt - columns.lead}
            flexShrink={0}
            paddingLeft={columns.handleAt - columns.lead}
            paddingY={isSelected ? space.rowPad : 0}
          >
            {/* Without a Client, desktop's title alone opens the row, so the list draws half as many native buttons. */}
            {row.handleTone ? (
              <Text color={pal.mark[row.handleTone]}>{row.handle}</Text>
            ) : look === 'desktop' ? (
              <Text>{row.handle}</Text>
            ) : (
              <Button
                plain
                key={`select-${row.id}`}
                label={row.handle}
                onPress={() => void select($, tab, row.id, index)}
              />
            )}
          </Box>
          {isSelected ? (
            <Box flexDirection="column" flexShrink={1} flexGrow={1} paddingRight={1} paddingY={space.rowPad}>
              {row.head ? withSideAge(row, headLine(headOf(row, row.head), pal.muted)) : null}
              {(row.head ? (el: JSX.Element) => el : (el: JSX.Element) => withSideAge(row, el))(
                <Text wrap="wrap">
                  <Text bold>{row.title}</Text>
                  {titleAfter ? <Text color={pal.muted}>{unbroken(titleAfter)}</Text> : null}
                </Text>,
              )}
              {row.subtitle}
              {body ? <Box marginTop={blankLine}>{body}</Box> : null}
              {status.length > 0 ? (
                <Box flexDirection="column" marginTop={blankLine}>
                  {status.map(s => (
                    <Text color={s.color} wrap="wrap">
                      {s.text}
                    </Text>
                  ))}
                </Box>
              ) : null}
              {keysBlock}
            </Box>
          ) : (
            <Box flexShrink={1} flexGrow={1} paddingRight={1}>
              {unselectedLine(
                row,
                // Opening the row draws its title as Text, so the title's Button leaves.
                () => void select($, tab, row.id, index),
                columns.textAt,
              )}
            </Box>
          )}
          {isAgeInSide && !isSelected ? (
            <Box
              width={TERMINAL_SIDE_CELLS}
              flexShrink={0}
              justifyContent="flex-end"
              paddingRight={1}
              paddingTop={isSelected ? space.rowPad : 0}
            >
              <Text color={pal.age}>{sideAge(row)}</Text>
            </Box>
          ) : null}
          {tree
            ? isSelected
              ? branch(tree, blankLine, TREE_LINE_AT, pal.selectionLine ?? pal.line)
              : branch(tree, 0)
            : null}
          {/* What select() scrolls into view. Drawn on the selected row alone, so the key exists
          only once that row has redrawn expanded. */}
          {isSelected ? (
            <Box
              key={`view-${row.id}`}
              position="absolute"
              top={0}
              bottom={0}
              left={0}
              width={1}
              // Desktop draws a column of ▌ as broken dashes, so there the bar is the Box's own fill.
              {...(look === 'desktop' && !pal.selection ? { backgroundColor: pal.key } : {})}
            >
              {pal.selection || look === 'desktop' ? null : <Text color={pal.key}>{SELECTION_BAR}</Text>}
            </Box>
          ) : null}
        </Box>
      )
    }
    // An empty tab names what would be there and when it comes. Docked, it sits in
    // the middle of the pane, one Text per line, since a Text cannot center its lines.
    // The lines are balanced: as narrow as they can be without adding a line.
    const emptyState = ({ title, hint: text = '' }: { title: string; hint?: string }) => {
      const wrap = (width: number) => {
        const lines: string[] = []
        for (const word of text.split(' ').filter(Boolean)) {
          const last = lines.at(-1)
          if (last !== undefined && last.length + 1 + word.length <= width) lines[lines.length - 1] = `${last} ${word}`
          else lines.push(word)
        }

        return lines
      }
      const room = e.props.bodyColumns - 6
      const most = Math.min(46, look === 'desktop' ? Math.floor(room * DESKTOP_CHARS_PER_CELL) : room)
      const count = wrap(most).length
      let width = Math.ceil(text.length / Math.max(count, 1))
      while (width < most && wrap(width).length > count) width++
      const lines = wrap(width)
      const align = isInline ? 'flex-start' : 'center'

      // The title and lines center as one block, so rounding cannot widen the gap between them.
      return (
        <Box flexDirection="column" flexGrow={1} justifyContent={align} alignItems={align}>
          <Box flexDirection="column" alignItems={align} paddingLeft={isInline ? 1 : 0}>
            <Text bold>{title}</Text>
            {lines.length > 0 ? (
              <Box flexDirection="column" alignItems={align} marginTop={blankLine}>
                {lines.map(line => (
                  <Text color={pal.muted}>{line}</Text>
                ))}
              </Box>
            ) : null}
          </Box>
        </Box>
      )
    }

    // Work under way that may change the rows: the PRs tab's refresh, or the other tabs' per-turn update.
    const isPrStatus = tab === 'prs' && prViews.length > 0
    const { isUpdating, error } = view.status
    const status = isPrStatus ? (prState.isFetching ? 'Refreshing PRs' : '') : isUpdating ? 'Updating…' : ''

    // A note on a row the pane no longer draws, as after a press on a row that left, shows on the status line.
    const drawnIds = new Set([
      ...Object.values(rows).flatMap(list => list.map(r => r.id)),
      ...prViews.map(pr => prMarkId(pr.ref)),
    ])
    const lineNote = Object.entries(notes)
      .filter(([id, n]) => !drawnIds.has(id) && now - n.at < SETTLED_MS)
      .map(([, n]) => n)
      .sort((a, b) => b.at - a.at)[0]

    // The keys no row shows, listed in the footer.
    const keyList = [
      { keys: TABS.map(t => t.hotkey).join(' '), does: 'Switch tabs' },
      { keys: 'j k', does: 'Select the next or previous row' },
      { keys: 'ctrl+x tab', does: 'Move focus to the line above the prompt, then the pane, then the prompt' },
    ]
    const keyColumn = Math.max(...keyList.map(k => k.keys.length)) + 2

    // The tab bar is drawn on the pane's own background, as part of the pane's
    // title bar. Inline, its names line up with the group titles.
    // Desktop draws the tabs in a Client, whose region takes the pointer over each whole tab.
    // The tabs Box pads the bar by 1 column on each side.
    const tabSizes = desktopTabSizes(
      TABS.map(({ id, label }) => ({ label, count: tabCounts[id] })),
      e.props.bodyColumns - 2,
    )
    const tabProps: TabsProps | null = hasClient
      ? {
          tabs: TABS.map(({ id, label }, n) => ({
            id,
            label,
            count: tabSizes.hasCounts ? tabCounts[id] : 0,
            countColor: pal.tone[id] ?? pal.mark[id],
            width: tabSizes.widths[n]!,
          })),
          shown: tab,
          gap: tabSizes.gap,
          colors: {
            tab: pal.tab ?? null,
            raised: pal.raised,
            raisedText: pal.raisedText ?? null,
            muted: pal.muted,
          },
        }
      : null
    const statusLines = [
      !isPrStatus && error ? (
        <Text color={pal.tone.error} wrap="wrap">
          {error}
        </Text>
      ) : null,
      // The band still draws without the tools, so every tab's status line says so.
      toolsRefused ? (
        <Text color={pal.tone.error} wrap="wrap">
          {TOOLS_REFUSED_TEXT}
        </Text>
      ) : null,
      lineNote ? (
        <Text color={pal.muted} wrap="wrap">
          {feedbackText({ is: 'note', note: lineNote.note, at: lineNote.at }, look)}
        </Text>
      ) : null,
    ]
    const tabText = (id: Tab, label: string) => `${label}${tabCounts[id] > 0 ? ` ${tabCounts[id]}` : ''}`
    // The terminal tabs' width at full padding, with the 1-column gaps between them and the row's own padding.
    const terminalTabsWidth = TABS.reduce((sum, t) => sum + tabText(t.id, t.label).length + 2 * TAB_PAD.length + 1, 1)
    const pad = terminalTabsWidth <= e.props.bodyColumns ? TAB_PAD : ' '
    // The docked terminal's tabs rest on a line in the unselected tabs' color, along their bottom row.
    const hasTabLine = !isInline && look !== 'desktop'
    const tabLine = pal.tab ?? pal.divider
    // Terminal.app draws block characters from its font, which leaves a seam between a half block and the filled
    // line beside it. There a tab is its filled name line alone.
    const hasHalfLines = termProgram !== 'Apple_Terminal'
    const tabs = (
      <Box
        paddingLeft={isInline ? 2 : 1}
        paddingRight={1}
        flexDirection="row"
        {...(hasTabLine ? { overflow: 'hidden' as const } : {})}
      >
        {/* ─ draws at the middle of its cell, where the tabs' ▀ ends, and the tabs draw over it. The tabs' Box
            clips it, as a row clips the tree (anthropics/claude-code#100030). */}
        {hasTabLine ? (
          <Box position="absolute" bottom={0} left={0} right={0} height={1}>
            <Text color={tabLine}>{'─'.repeat(e.props.bodyColumns)}</Text>
          </Box>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={isInline ? 3 : look === 'desktop' ? 2 : 1}>
          {hasClient && tabProps ? (
            <elements.Client key="tabs" module="./tabs-client.tsx" height={TAB_HEIGHT} props={tabProps} />
          ) : null}
          {tabProps
            ? null
            : TABS.map(({ id, label }) => {
                const count = tabCounts[id]

                if (isInline)
                  return (
                    <Box key={`tab-block-${id}`} flexDirection="row">
                      {tab === id ? (
                        <Text bold underline>
                          {label}
                        </Text>
                      ) : (
                        <Button plain key={`tab-${id}`} label={label} onPress={() => void showTab($, id)} />
                      )}
                      {count > 0 ? (
                        <Text bold={tab === id} color={pal.tone[id]}>
                          {' '}
                          {count}
                        </Text>
                      ) : null}
                    </Box>
                  )

                const width = tabText(id, label).length + 2 * pad.length

                // Desktop: every tab is one native button, the shown one the primary. The key stays the
                // same in every drawing: the app takes the focus off the pane when the element holding
                // it leaves, and the next click would only bring it back.
                // A Button sizes to its label, so non-breaking spaces widen the tab; plain spaces would collapse.
                // A native tab element would replace this (anthropics/claude-code#100890).
                if (look === 'desktop')
                  return (
                    <Button
                      key={`tab-${id}`}
                      label={`${DESKTOP_TAB_PAD}${count > 0 ? `${label} ${count}` : label}${DESKTOP_TAB_PAD}`}
                      {...(tab === id ? { variant: 'primary' as const } : {})}
                      onPress={() => void showTab($, id)}
                    />
                  )

                // A tab is its name's line between half lines of its fill, ▄ above and ▀ below, so the name sits
                // in the middle of a shape two lines tall. Without half lines, its bottom line is the line the tabs
                // rest on. The selected tab is raised and bold. It has no colored
                // line along its top: that edge falls mid-cell, where the line would need a third color in a cell
                // that draws two.
                if (tab === id)
                  return (
                    <Box flexDirection="column" flexShrink={0}>
                      <Text color={pal.raised}>{(hasHalfLines ? '▄' : ' ').repeat(width)}</Text>
                      <Text backgroundColor={pal.raised}>
                        {pad}
                        <Text bold color={pal.raisedText} backgroundColor={pal.raised}>
                          {label}
                        </Text>
                        {count > 0 ? (
                          <Text bold color={pal.tone[id] ?? pal.raisedText} backgroundColor={pal.raised}>
                            {' '}
                            {count}
                          </Text>
                        ) : null}
                        {pad}
                      </Text>
                      {hasHalfLines ? (
                        <Text color={pal.raised}>{'▀'.repeat(width)}</Text>
                      ) : (
                        <Text color={tabLine}>{'─'.repeat(width)}</Text>
                      )}
                    </Box>
                  )

                // Each line is a Button, so a click anywhere on the tab selects it. Under the pointer, the keyed
                // Box raises the tab: its half lines by their glyphs' color, its name's line by its fill. A palette
                // with no tab fill draws no half lines: its bottom line is the line the tabs rest on, and only the
                // name's line raises.
                const show = () => void showTab($, id)
                const edgeFill = hasHalfLines ? pal.tab : undefined
                const edgeHover = edgeFill ? raiseEdge : { inverse: false }

                return (
                  <Box key={`tab-block-${id}`} flexDirection="column" flexShrink={0}>
                    <Button plain key={`tab-${id}-above`} hover={edgeHover} onPress={show}>
                      {edgeFill ? (
                        <Text color={edgeFill} hover={raiseEdge}>
                          {'▄'.repeat(width)}
                        </Text>
                      ) : (
                        ' '.repeat(width)
                      )}
                    </Button>
                    <Box flexDirection="row" backgroundColor={pal.tab}>
                      <Button plain key={`tab-${id}-before`} label={pad} hover={raise} onPress={show} />
                      <Button plain key={`tab-${id}`} label={label} hover={raise} onPress={show} />
                      {count > 0 ? (
                        <Text color={pal.tone[id]} hover={raise}>
                          {' '}
                          {count}
                        </Text>
                      ) : null}
                      <Button plain key={`tab-${id}-after`} label={pad} hover={raise} onPress={show} />
                    </Box>
                    <Button plain key={`tab-${id}-below`} hover={edgeHover} onPress={show}>
                      {edgeFill ? (
                        <Text color={edgeFill} hover={raiseEdge}>
                          {'▀'.repeat(width)}
                        </Text>
                      ) : (
                        <Text color={tabLine}>{'─'.repeat(width)}</Text>
                      )}
                    </Button>
                  </Box>
                )
              })}
        </Box>
      </Box>
    )
    // Desktop draws dimColor as plain text, so the status takes the ages' dimmer gray there.
    const statusText = look === 'desktop' ? <Text color={pal.age}>{status}</Text> : <Text dimColor>{status}</Text>
    // Each takes its own line under the tab row.
    const hasRail = isInline && look === 'terminal' && e.props.bodyColumns >= INLINE_RAIL_AT
    // Each tab is one line of the column, padded to the column's width. Every cell of it is a Button, so a click
    // anywhere on the line shows the tab. The shown tab is filled and bold, as the docked tabs draw it.
    const railWidth = Math.max(...TABS.map(t => tabText(t.id, t.label).length)) + 2 * TAB_PAD.length
    const rail = (
      <Box flexDirection="column" flexShrink={0} paddingLeft={1} marginRight={RAIL_GUTTER}>
        {TABS.map(({ id, label }) => {
          const count = tabCounts[id]
          const fill = ' '.repeat(railWidth - tabText(id, label).length - TAB_PAD.length)
          if (tab === id)
            return (
              <Text key={`rail-${id}`} backgroundColor={pal.raised}>
                {TAB_PAD}
                <Text bold color={pal.raisedText} backgroundColor={pal.raised}>
                  {label}
                </Text>
                {count > 0 ? (
                  <Text bold color={pal.tone[id] ?? pal.raisedText} backgroundColor={pal.raised}>
                    {' '}
                    {count}
                  </Text>
                ) : null}
                {fill}
              </Text>
            )
          const show = () => void showTab($, id)

          return (
            <Box key={`rail-${id}`} flexDirection="row">
              <Button plain key={`tab-${id}-before`} label={TAB_PAD} hover={raise} onPress={show} />
              <Button plain key={`tab-${id}`} label={label} hover={raise} onPress={show} />
              {count > 0 ? (
                <Button plain key={`tab-${id}-count`} hover={raise} onPress={show}>
                  <Text color={pal.tone[id]}> {count}</Text>
                </Button>
              ) : null}
              <Button plain key={`tab-${id}-after`} label={fill} hover={raise} onPress={show} />
            </Box>
          )
        })}
      </Box>
    )
    const statusBlock = statusLines.some(Boolean) ? (
      <Box flexDirection="column" paddingX={hasRail ? 1 : isInline ? 2 : 1} paddingTop={hasRail ? 0 : 1}>
        {statusLines}
      </Box>
    ) : null
    // The footer's one line shows the status at its right end, and, where keys work, opens the list
    // of keys as a drawer above it. The drawer is absolute, so it covers the rows above instead of moving the line.
    const footer = (
      <Box flexDirection="column" paddingX={1} paddingTop={blankLine}>
        <Box flexDirection="row" paddingX={1} justifyContent="space-between" columnGap={3}>
          {look === 'desktop' ? (
            <Box />
          ) : (
            <Button
              plain
              dimColor
              key="key-list"
              label={isKeyListShown ? '▾ Keys' : '▴ Keys'}
              onPress={() => void update($, IS_KEY_LIST_SHOWN, shown => !shown)}
            />
          )}
          {statusText}
          {look !== 'desktop' && isKeyListShown ? (
            <Box
              position="absolute"
              bottom={1}
              left={-1}
              right={-1}
              flexDirection="column"
              paddingX={2}
              paddingY={1}
              backgroundColor={pal.raised}
            >
              {keyList.map(k => (
                <Box key={`key-list-${k.keys}`} flexDirection="row">
                  <Box width={keyColumn} flexShrink={0}>
                    <Text bold color={pal.raisedText}>
                      {k.keys}
                    </Text>
                  </Box>
                  <Text color={pal.raisedText ?? pal.muted} wrap="wrap">
                    {k.does}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      </Box>
    )

    // A group's title: its name, and how many of its items are open. An empty
    // group's own line says it has none, so its title has no count.
    // Desktop draws a group's title at the rows' text column.
    // A group's empty line, at its rows' text column.
    const groupEmpty = (title: string) =>
      look === 'desktop'
        ? desktopFrame({
            key: `empty-${title}`,
            children: <Text color={pal.muted}>{groupEmptyText(title)}</Text>,
          })
        : // The two spaces start the text where the fold line's count starts, after its "▸ ".
          treeRow('last', null, <Text color={pal.muted}>{`  ${groupEmptyText(title)}`}</Text>, `empty-${title}`)
    const groupTitle = (title: string, count: number) =>
      look === 'desktop' ? (
        desktopFrame({
          padY: 0,
          children: (
            <Text>
              <Text bold>{title}</Text>
              {count > 0 ? <Text color={pal.muted}>{`${DOT}${count}`}</Text> : null}
            </Text>
          ),
        })
      ) : (
        <Box paddingLeft={TREE_LINE_AT}>
          <Text>
            <Text bold>{title}</Text>
            {count > 0 ? <Text color={pal.muted}>{`${DOT}${count}`}</Text> : null}
          </Text>
        </Box>
      )
    const section = (children: JSX.Element | JSX.Element[]) =>
      look === 'desktop' ? (
        <Box flexDirection="column" paddingTop={blankLine}>
          {children}
        </Box>
      ) : (
        <Box flexDirection="column">{children}</Box>
      )
    // A tab's sections, a line apart. On desktop a hairline rule parts each from the one above, so the sections read
    // apart without cards; the tabs' own line already parts the first from the tabs. `space` is the room on each
    // side of a rule, in the tree's half lines.
    const sections = (list: JSX.Element[], space = 1) => (
      <Box flexDirection="column" flexGrow={1} gap={look === 'desktop' ? 0 : isInline ? 1 : 2}>
        {look === 'desktop'
          ? list.flatMap((el, n) =>
              n === 0
                ? [el]
                : [
                    <Box
                      key={`rule-${n}`}
                      marginTop={space}
                      marginBottom={space - blankLine}
                      // Starts at the text column, past the marks, as the section titles do.
                      marginLeft={FRAME_INSET_PT / DESKTOP_CELL_PT + DESKTOP_MARK_CELLS}
                      height={1 / DESKTOP_LINE_PT}
                      backgroundColor={pal.divider}
                    />,
                    el,
                  ],
            )
          : // The terminal parts sections with two blank lines: a rule would read as one more of its row rules.
            list}
      </Box>
    )
    // A blank line in the tree, but for its │: under a title, so the children
    // do not crowd it, and between two-line entries, so they read apart. Inline
    // it is left out, so callers spread what this returns.
    // On desktop, ROW_PAD_PT under a title sets it apart from its first row, counted in the tree's half lines.
    const titleGap = (hasChildren = true) =>
      isInline
        ? []
        : look === 'desktop'
          ? [<Box paddingTop={(2 * ROW_PAD_PT) / DESKTOP_LINE_PT} />]
          : [
              <Box paddingLeft={TREE_LINE_AT}>
                <Text color={pal.line}>{hasChildren ? '│' : ' '}</Text>
              </Box>,
            ]
    // A closed item or finding under the open ones: what was asked, then how it closed and when.
    const closedRow = (d: ClosedLine, pos: TreePos) =>
      look === 'desktop'
        ? // Nested under its fold line, with its mark under the fold's label and half a row's padding, so the
          // closed items read as the fold's group.
          desktopFrame({
            key: `closed-${d.id}`,
            indent: DESKTOP_MARK_CELLS,
            isMarkHung: false,
            padY: space.rowPad / 2,
            mark: <Text color={pal.age}>{CLOSED_MARKS[closedState(d)]}</Text>,
            side: <Text color={pal.age}>{shortAgo(now - d.at)}</Text>,
            children: [
              <Text wrap="wrap" color={pal.muted}>
                {d.ask}
              </Text>,
              <Text wrap="wrap" color={pal.age}>
                {outcomeText(d)}
              </Text>,
            ],
          })
        : treeRow(
            pos,
            <Text color={pal.muted}>{CLOSED_MARKS[closedState(d)]}</Text>,
            <Box flexDirection="row">
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text wrap="wrap" color={pal.muted}>
                  {d.ask}
                </Text>
                <Text wrap="wrap" color={pal.age}>
                  {outcomeText(d)}
                </Text>
              </Box>
              <Box width={TERMINAL_SIDE_CELLS} flexShrink={0} justifyContent="flex-end" paddingRight={1}>
                <Text color={pal.age}>{shortAgo(now - d.at)}</Text>
              </Box>
            </Box>,
            `closed-${d.id}`,
            1,
          )
    // The row that folds or unfolds a list's closed items, with how many there are.
    // It sits apart from the list's tree, and the closed items hang from its arrow.
    // On desktop a Client takes a click on every cell of the line, where a Button takes one only on its label.
    const foldRow = (kind: FoldKind, count: number, isUnfolded: boolean) =>
      hasClient ? (
        // The chevron Svg sits under the Client, which takes the clicks, as Undo's does.
        <Box key={`fold-row-${kind}`} flexDirection="row" overflow="hidden">
          {'Svg' in elements ? (
            <elements.Svg
              source={chevronSvg(isUnfolded, foldHover === kind)}
              alt={isUnfolded ? 'Unfolded' : 'Folded'}
              width={FRAME_INSET_PT + DESKTOP_MARK_CELLS * DESKTOP_CELL_PT}
              height={2 * ROW_PAD_PT + DESKTOP_LINE_PT}
            />
          ) : null}
          <Box position="absolute" top={0} left={0} width="100%">
            <elements.Client
              key={`fold-${kind}`}
              module="./fold-client.tsx"
              width="100%"
              props={
                {
                  markCells: DESKTOP_MARK_CELLS,
                  label: foldLabel(count),
                  isUnfolded,
                  padY: DESKTOP_ROW_PAD,
                  colors: {
                    rest: isInline ? null : (pal.card ?? null),
                    text: pal.age,
                    hoverText: 'text',
                  },
                } satisfies FoldProps
              }
            />
          </Box>
        </Box>
      ) : (
        // One Button for the arrow and the count; the two spaces put the count where other rows' text starts.
        treeRow(
          null,
          null,
          <Box flexDirection="row">
            <Button
              plain
              dimColor
              key={`fold-${kind}`}
              label={`${isUnfolded ? '▾' : '▸'} ${foldLabel(count)}`}
              onPress={() =>
                void update($, UNFOLDED, u => (u.includes(kind) ? u.filter(k => k !== kind) : [...u, kind]))
              }
            />
          </Box>,
          `fold-row-${kind}`,
        )
      )
    // The fold row, which counts every close, and, unfolded, the closed items it lists, then how many it leaves
    // out; nothing when none closed.
    const closedFold = (kind: FoldKind, closed: ClosedLine[], total: number, isUnfolded: boolean) => {
      const earlier = earlierLabel(total, closed.length)
      return closed.length === 0
        ? []
        : [
            ...(space.isFoldGapped ? titleGap(false) : []),
            foldRow(kind, total, isUnfolded),
            // A line of the closed items' tree parts them from the fold line, as a group's title is parted from its rows.
            ...(isUnfolded && look !== 'desktop' && !isInline
              ? [
                  <Box key={`fold-gap-${kind}`} paddingLeft={TREE_LINE_AT + markWidth}>
                    <Text color={pal.line}>│</Text>
                  </Box>,
                ]
              : []),
            ...(isUnfolded ? closed.map((d, n) => closedRow(d, childPos(n, closed.length + (earlier ? 1 : 0)))) : []),
            ...(isUnfolded && earlier
              ? [
                  look === 'desktop'
                    ? desktopFrame({
                        key: `earlier-${kind}`,
                        indent: DESKTOP_MARK_CELLS,
                        isMarkHung: false,
                        padY: space.rowPad / 2,
                        children: <Text color={pal.age}>{earlier}</Text>,
                      })
                    : // On the closed items' tree, with its text where their titles start.
                      treeRow(
                        childPos(closed.length, closed.length + 1),
                        <Text> </Text>,
                        <Text color={pal.age}>{earlier}</Text>,
                        `earlier-${kind}`,
                        1,
                      ),
                ]
              : []),
          ]
    }
    // A row that just closed stays where it was, with a ✓ and its outcome, and
    // [Undo] after the person's own Done or Dismiss, until it joins its list's
    // closed items. It cannot be selected. `undo` is that press. An answer
    // whose message has not reached Claude reads "Queued: <answer>" instead. A
    // lapsed close, such as Dismissed, Expired or one by Claude, reads muted.
    // Undo on a row that just closed, with a fill that drains as its time runs out. The
    // terminal redraws it on the steps the leave bar already takes. Desktop's native button draws no fill, so there
    // it is an Svg pill whose fill animates on its own, under a Client that takes its clicks.
    const undoButton = (undo: RowPress | PrPress, at: number) => {
      const key = `undo-${pressRowId(undo)}`
      const label = ' ↺ Undo '
      const onPress = (press: { surface: UiPressArgument['surface'] }) => runPress($, undo, press.surface)
      if (hasClient && 'Svg' in elements) {
        followUpPresses.set(key, onPress)
        const leftMs = Math.max(0, SETTLED_MS - (now - at))
        return (
          <Box key={`${key}-${at}`} width={UNDO_CELLS} height={UNDO_HEIGHT_PT / DESKTOP_LINE_PT}>
            <elements.Svg
              source={undoSvg(leftMs / SETTLED_MS, leftMs)}
              alt="Undo"
              width={UNDO_CELLS * DESKTOP_CELL_PT}
              height={UNDO_HEIGHT_PT}
            />
            <Box position="absolute" top={0} left={0}>
              <elements.Client
                key={key}
                module="./undo-client.tsx"
                width={UNDO_CELLS}
                height={UNDO_HEIGHT_PT / DESKTOP_LINE_PT}
                props={{ pressKey: key, hover: 'rgba(128, 128, 128, 0.12)' } satisfies UndoProps}
              />
            </Box>
          </Box>
        )
      }
      if (look !== 'terminal') return <Button key={key} label="↺ Undo" onPress={onPress} />
      const cells = [...label]
      const filled = Math.ceil((Math.max(0, SETTLED_MS - (now - at)) / SETTLED_MS) * cells.length)

      return (
        <Button key={key} onPress={onPress}>
          <Text backgroundColor={pal.divider}>{cells.slice(0, filled).join('')}</Text>
          <Text>{cells.slice(filled).join('')}</Text>
        </Button>
      )
    }
    const settledContent = (
      what: string,
      outcome: string,
      at: number,
      undo: RowPress | PrPress | null,
      isQueued = false,
      isLapsed = false,
    ) => {
      if (look === 'desktop') {
        // The ask, its outcome muted after it, wrapping together, and Undo at the right.
        const after = `${DOT}${isQueued ? `Queued: ${outcome}` : outcome}`
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" alignItems="center">
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="wrap">
                  {what}
                  <Text color={pal.muted}>{after}</Text>
                </Text>
              </Box>
              {undo ? (
                <Box flexShrink={0} paddingLeft={1}>
                  {undoButton(undo, at)}
                </Box>
              ) : null}
            </Box>
            {undo ? null : leaveBar(at)}
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end" color={pal.muted}>
            {what}
          </Text>
          <Box flexDirection="row" columnGap={2}>
            <Text wrap="wrap" color={isQueued || isLapsed ? pal.muted : pal.tone.done}>
              {isQueued ? `Queued: ${outcome}` : outcome}
            </Text>
            {undo ? undoButton(undo, at) : null}
          </Box>
          {undo ? null : leaveBar(at)}
        </Box>
      )
    }
    // A just-closed row with no Undo, whose draining bar shows under it.
    const isBarred = (x: Entry | undefined) =>
      x !== undefined && !('row' in x) && !x.settled.actions.some(a => a.press.action === 'undo')
    const settledRow = ({ settled: r, state }: Extract<Entry, { settled: RowView }>, pos?: TreePos) => {
      const undo = r.actions.find(a => a.press.action === 'undo')?.press ?? null
      if (look === 'desktop') {
        const after = `${DOT}${state.isQueued ? `Queued: ${state.label}` : state.label}`
        return desktopFrame({
          key: `settled-${r.id}`,
          markCells: DESKTOP_MARK_CELLS + markExtra(r.id),
          // The ✓ waits for the answer to reach Claude.
          mark: state.isQueued ? null : <Text color={pal.muted}>✓</Text>,
          side: undo ? undoButton(undo, state.at) : null,
          padY: space.settledPad,
          isCentered: true,
          children: [
            <Text wrap="wrap">
              {r.title}
              <Text color={pal.muted}>{after}</Text>
            </Text>,
            undo ? null : leaveBar(state.at),
          ],
        })
      }
      const columns = columnsFor(pos, markExtra(r.id))
      const content = settledContent(r.title, state.label, state.at, undo, state.isQueued, state.isLapsed)
      // The ✓ waits for the answer to reach Claude; the blank keeps the row's text in line.
      const mark = state.isQueued ? <Text> </Text> : <Text color={pal.muted}>✓</Text>
      // In a group's tree, or flat as Findings lists its rows. On desktop it pads itself as a closed row does.
      return pos ? (
        <Box key={`settled-${r.id}`} flexDirection="column" paddingY={space.settledPad}>
          {treeRow(pos, mark, content, undefined, 0, undefined, markExtra(r.id))}
        </Box>
      ) : (
        <Box
          key={`settled-${r.id}`}
          flexDirection="row"
          alignItems="flex-start"
          overflow="hidden"
          paddingY={space.settledPad}
        >
          <Box width={columns.lead} flexShrink={0} />
          <Box width={columns.textAt - columns.lead} flexShrink={0} paddingLeft={columns.handleAt - columns.lead}>
            {mark}
          </Box>
          <Box flexDirection="column" flexShrink={1} flexGrow={1} paddingRight={1}>
            {content}
          </Box>
        </Box>
      )
    }
    const needsYouView = () => {
      // Every group shows, with its empty line while it has nothing open, unless the inbox could not be read.
      const groups = needsYouGroups.flatMap(g => {
        const { entries } = g
        const closed = closedShown(view.needsYou.closed[g.list], settledIn(entries))
        if (isUnread) return []
        const isUnfolded = unfolded.includes(g.kind)
        // The group's children in order: its open items, then the fold row and, unfolded, the closed items.
        const open = divided(
          entries.map((x, n) =>
            'row' in x ? listRow(x.row, childPos(n, entries.length)) : settledRow(x, childPos(n, entries.length)),
          ),
          g.kind,
          true,
          n => isBarred(entries[n]),
          Math.max(0, ...entries.map(x => markExtra(entryId(x)))),
        )
        const tail = closedFold(
          g.kind,
          closed,
          closedTotal(view.needsYou.closed[g.list], settledIn(entries)),
          isUnfolded,
        )

        // A row handed to Claude stays listed but leaves the count.
        return [
          section([
            groupTitle(g.title, g.rows.filter(r => !r.fold).length),
            ...titleGap(),
            ...(open.length > 0 ? open : [groupEmpty(g.title)]),
            ...tail,
          ]),
        ]
      })
      const isNothing = needsYouGroups.every(
        g => g.entries.length === 0 && closedTotal(view.needsYou.closed[g.list], settledIn(g.entries)) === 0,
      )
      // A saved session the store could not read is unknown, not empty, so it never reads as "Nothing needs you."
      const unread = isUnread
        ? [
            section(
              <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={2}>
                {isReadingAgain ? (
                  <Text color={pal.muted}>Reading the inbox…</Text>
                ) : (
                  <Text color={pal.tone.error}>Could not read the inbox.</Text>
                )}
                <Button key="read-again" label="Try again" onPress={() => void readAgain($)} />
              </Box>,
            ),
          ]
        : []
      // A tab that has never had anything keeps its centered text, whose hint says what comes here.
      if (isNothing && !stop && unread.length === 0) return emptyState(emptyText('needsYou', 'Claude'))
      // A stop shows above the list. An API error can be resumed from here; the other stops
      // need a fix outside the session first, so they only say what it is.
      const outside = stop
        ? [
            section(
              <Box flexDirection="column" paddingLeft={1}>
                <Text wrap="truncate-end">
                  <Text color={pal.tone.error} bold>
                    Stopped
                  </Text>
                  <Text color={pal.muted}>
                    {DOT}
                    {ago(now - stop.at)}
                  </Text>
                </Text>
                {stop.kind === 'api-error' ? (
                  <Box flexDirection="column">
                    <Text wrap="wrap">{capitalized(stopText(stop))}.</Text>
                    {resuming?.is === 'refused' ? (
                      <Text color={pal.tone.error} wrap="wrap">
                        Not sent: {resuming.why}
                      </Text>
                    ) : null}
                    <Box flexDirection="row">
                      <Button
                        key="resume"
                        label={resuming?.is === 'sending' ? 'Resuming…' : 'Resume'}
                        onPress={() => void resume($)}
                      />
                    </Box>
                  </Box>
                ) : (
                  <Text wrap="wrap">
                    {capitalized(stopText(stop))}. {stopFix(stop)}
                  </Text>
                )}
              </Box>,
            ),
          ]
        : []

      return sections([...outside, ...unread, ...groups])
    }

    // A finding stays listed until Claude closes it or the person dismisses it. Then it settles and moves to Closed.
    const findingsView = () => {
      const settled = settledIn(findingEntries)
      if (findingEntries.length === 0 && closedTotal(view.findings.closed, settled) === 0)
        return emptyState(emptyText('findings', 'Claude'))
      // Each kind keeps its own Closed fold, as each Needs you group does. A row handed to Claude stays listed but
      // leaves the count.
      const groups = lists.findingGroups.map(g => {
        const closedOf = view.findings.closed.filter(f => f.kind === g.kind)
        const closed = closedShown(closedOf, settled).map(f => ({
          id: f.id,
          ask: f.title,
          at: f.closedAt,
          how: f.how,
          outcome: f.outcome,
        }))
        return section([
          groupTitle(g.title, rowsIn(g.entries).filter(r => !r.fold).length),
          ...titleGap(),
          ...(g.entries.length === 0 ? [groupEmpty(g.title)] : []),
          ...divided(
            g.entries.map((x, n) =>
              'row' in x ? listRow(x.row, childPos(n, g.entries.length)) : settledRow(x, childPos(n, g.entries.length)),
            ),
            g.kind,
            true,
            n => isBarred(g.entries[n]),
          ),
          ...closedFold(g.kind, closed, closedTotal(closedOf, settled), unfolded.includes(g.kind)),
        ])
      })

      return sections(groups)
    }

    // A PR the person just dismissed keeps its title, settled, with [Undo], until it leaves.
    const settledPrBlock = (pr: PrView) =>
      section([
        treeRow(
          null,
          <Text color={pal.muted}>✓</Text>,
          settledContent(
            `#${pr.number} ${pr.title}`,
            'Dismissed',
            lastActions[prMarkId(pr.ref)]?.at ?? now,
            {
              action: 'pr-undo',
              ref: pr.ref,
            },
            false,
            true,
          ),
          `settled-pr:${pr.ref}`,
        ),
      ])
    // A PR block's checks or threads, under a group title that says their kind once. The title sits a line below
    // the lines above it. On desktop it sits next to its first row, whose own padding is the only gap; in the
    // terminal a connector line separates them, as under every other group title.
    const prRowGroup = (title: string, group: Row[], key: string) =>
      group.length === 0
        ? []
        : [
            <Box key={`group-${key}`} marginTop={blankLine}>
              {groupTitle(title, group.length)}
            </Box>,
            ...(look === 'desktop' ? [] : titleGap()),
            ...divided(
              group.map((r, n) => listRow(r, childPos(n, group.length))),
              key,
              true,
            ),
          ]
    const prBlock = ({
      pr,
      isSettled,
      checks,
      threads,
    }: {
      pr: PrView
      isSettled: boolean
      rows: Row[]
      checks: Row[]
      threads: Row[]
    }) => {
      if (isSettled) return settledPrBlock(pr)
      const { status, head: statusHead, unlisted } = readiness(pr, isThreadSent)
      const tone = PR_TONES[status]
      const waitingOn = threadsOnYou(pr, isThreadSent)
      // A Dismiss left on a PR that is tracked again, as one a later reply links, is over.
      const prLast = lastActions[prMarkId(pr.ref)]?.action === 'pr-dismiss' ? null : lastActionText(prMarkId(pr.ref))
      const retry = prRetryOf(lastActions[prMarkId(pr.ref)], pr.ref, null)
      const prActions: Action[] = [
        ...(retry
          ? [
              {
                key: `retry-${pr.ref}`,
                label: 'Try again',
                icon: '↻',
                kind: retry.kind,
                onPress: prPress(retry.press),
              },
            ]
          : []),
        ...(status === 'ready'
          ? [
              {
                key: `merge-${pr.ref}`,
                label: again(prMarkId(pr.ref), 'pr-merge', 'Merge'),
                kind: 'handoff' as const,
                onPress: prPress({ action: 'pr-merge', ref: pr.ref }),
              },
            ]
          : []),
        ...(pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING'
          ? [
              {
                key: `resolve-${pr.ref}`,
                label: again(prMarkId(pr.ref), 'pr-conflicts', 'Resolve conflicts'),
                kind: 'handoff' as const,
                onPress: prPress({ action: 'pr-conflicts', ref: pr.ref }),
              },
            ]
          : []),
        ...(waitingOn.length > 1
          ? [
              {
                key: `address-all-${pr.ref}`,
                label: again(prMarkId(pr.ref), 'pr-address-all', `Address all ${waitingOn.length} threads`),
                kind: 'handoff' as const,
                onPress: prPress({ action: 'pr-address-all', ref: pr.ref }),
              },
            ]
          : []),
        {
          key: `open-${pr.ref}`,
          label: 'Open PR',
          icon: '↗',
          kind: 'local',
          onPress: prPress({ action: 'pr-open', ref: pr.ref }),
        },
        ...(pr.ref !== prState.branchRef
          ? [
              {
                key: `dismiss-pr-${pr.ref}`,
                label: 'Dismiss',
                kind: 'mark' as const,
                onPress: prPress({ action: 'pr-dismiss', ref: pr.ref }),
              },
            ]
          : []),
      ]

      // The status word follows the title in its color, then the reasons no row below lists, muted, so the title stays
      // the loudest text.
      const titleLine = (
        <Text wrap="wrap">
          <Text color={look === 'desktop' ? pal.mark.prs : pal.tone.prs}>{`#${pr.number}\u2002`}</Text>
          <Text bold>{pr.title}</Text>
          {/* Desktop's palette names few tones, so a status falls back to its mark's color there. */}
          <Text color={tone ? (pal.tone[tone] ?? pal.mark[tone]) : pal.muted}>{`\u2002${statusHead}`}</Text>
          <Text color={pal.muted}>{unlisted.map(r => `${DOT}${r}`).join('')}</Text>
        </Text>
      )
      const statusBlock = (
        <Box flexDirection="column">
          {/* The next poll is minutes away, and desktop has no key to refresh with. */}
          {pr.error ? (
            <Box flexDirection="column">
              <Text color={pal.tone.error} wrap="wrap">
                Last refresh failed: {pr.error}
              </Text>
              {prState.isFetching ? <Text color={pal.muted}>Refreshing…</Text> : null}
              <Box flexDirection="row">
                <Button key={`refresh-${pr.ref}`} label="Retry" onPress={() => void findPrs($)} />
              </Box>
            </Box>
          ) : null}
          <Box
            flexDirection="row"
            flexWrap="wrap"
            columnGap={space.buttonGap}
            rowGap={look === 'desktop' ? 1 : 0}
            marginTop={blankLine}
          >
            {/* On desktop the first action, the one that moves the PR on, is the primary button. Dismiss is quiet. */}
            {prActions.map((a, n) =>
              a.key.startsWith('dismiss-') ? (
                <Button key={a.key} plain dimColor label={a.label} onPress={a.onPress} />
              ) : look === 'desktop' ? (
                <Button
                  key={a.key}
                  label={desktopLabel(a)}
                  {...(n === 0 ? { variant: 'primary' as const } : {})}
                  onPress={a.onPress}
                />
              ) : (
                <Button key={a.key} label={a.label} onPress={a.onPress} />
              ),
            )}
          </Box>
          {prLast ? (
            <Box marginTop={look === 'desktop' ? 1 : 0}>
              <Text color={prLast.isFailure ? pal.tone.error : pal.muted} wrap="wrap">
                {prLast.text}
              </Text>
            </Box>
          ) : null}
        </Box>
      )

      // On desktop the title and actions start at the rows' text column, as group titles do there, so the block and
      // its rows share one edge.
      return section([
        ...(look === 'desktop'
          ? [
              desktopFrame({ key: `pr-title-${pr.ref}`, padY: 0, children: titleLine }),
              desktopFrame({ key: `pr-status-${pr.ref}`, padY: 0, children: statusBlock }),
            ]
          : [<Box paddingLeft={1}>{titleLine}</Box>, <Box paddingLeft={1}>{statusBlock}</Box>]),
        // Threads come first: a thread waits on the person, and a failing check usually on Claude.
        ...prRowGroup('Review threads', threads, `${pr.ref}-threads`),
        ...prRowGroup('Failing checks', checks, `${pr.ref}-checks`),
      ])
    }
    // Linked PRs past MAX_PRS are not fetched, so the tab names them instead of dropping them unsaid.
    const olderPrs = () => {
      const text = olderPrsText(ledger.prs)
      if (!text) return []
      const line = (
        <Text color={pal.muted} wrap="wrap">
          {text}
        </Text>
      )

      return [
        section(
          look === 'desktop' ? (
            desktopFrame({ key: 'older-prs', padY: 0, children: line })
          ) : (
            <Box paddingLeft={1}>{line}</Box>
          ),
        ),
      ]
    }
    const prsView = () =>
      prGroups.length === 0 ? (
        <Box flexDirection="column" flexGrow={1}>
          {/* Loading keeps the empty state's text, so only the title changes when the fetch ends. */}
          {emptyState({
            title: prState.isFetching ? 'Checking for PRs…' : 'No PRs',
            hint: 'Your PRs show here when this session opens or links one, or when your branch has one.',
          })}
        </Box>
      ) : (
        // A PR block is denser than a list, with its buttons last, so its rules take a full line on each side.
        sections([...prGroups.map(prBlock), ...olderPrs()], 2)
      )

    const move = (step: number) => {
      const to = Math.min(Math.max(at + step, 0), ids.length - 1)
      void select($, tab, ids[to] ?? '', to)
    }
    // With no row open, j and k open the first row even when it is the only one.
    const moveKeys: KeyAction[] =
      ids.length > 1 || (at < 0 && ids.length > 0)
        ? [
            { key: 'next', label: 'Next', hotkey: 'j', kind: 'view', onPress: () => move(1) },
            { key: 'previous', label: 'Previous', hotkey: 'k', kind: 'view', onPress: () => move(-1) },
          ]
        : []
    const tabKeys: KeyAction[] = TABS.map(({ id, label, hotkey }) => ({
      key: `tab-key-${id}`,
      label,
      hotkey,
      kind: 'view',
      onPress: () => void showTab($, id),
    }))

    const selectedRow = rows[tab][at]
    const selectedActions = selectedRow ? rowActions(selectedRow) : null
    const rowKeys = selectedActions ? [...selectedActions.keys, ...selectedActions.more, ...selectedActions.hidden] : []

    // The pane takes at least the room the engine gives its body, so the footer
    // sits at its bottom edge until the content is taller. Inline, where the frame
    // fits the tree, that keeps its height the same on every tab. The engine has
    // no fixed footer, so past that it follows the content. A pane takes a key
    // only as a Button's hotkey, so the tab keys, j, k and the selected row's keys
    // are Buttons in a hidden Box.
    const tabView = tab === 'findings' ? findingsView() : tab === 'prs' ? prsView() : needsYouView()
    const drawn = (
      <Box flexDirection="column" minHeight={e.props.scroll.bodyRows} backgroundColor={pal.body}>
        {showsDemoNotices ? (
          // The notice is quiet, on one line with its button, as each app words a passing note.
          <Box
            flexDirection="row"
            alignItems="center"
            columnGap={2}
            paddingX={isInline ? 2 : 1}
            marginBottom={blankLine}
          >
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap" color={pal.muted}>
                {DEMO_NOTICE}
              </Text>
            </Box>
            <Button key="hide-demo" label="Hide demo" onPress={() => void setDemo($, false)} />
          </Box>
        ) : null}
        {hasRail ? (
          <Box flexDirection="row" flexGrow={1}>
            {rail}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {statusBlock}
              <Box flexDirection="column" paddingRight={1} flexGrow={1}>
                {tabView}
              </Box>
            </Box>
          </Box>
        ) : (
          [
            tabs,
            statusBlock,
            <Box flexDirection="column" paddingX={1} paddingTop={blankLine} flexGrow={1}>
              {tabView}
            </Box>,
          ]
        )}
        {/* Desktop takes no keys: a Button's hotkey does nothing there, so it gets neither the list of keys nor the hidden Buttons. */}
        {footer}
        {look === 'desktop' ? null : (
          <Box display="none">
            {keyBindings([...tabKeys, ...moveKeys])}
            {keyBindings(rowKeys, '-key')}
          </Box>
        )}
      </Box>
    )
    if (look === 'desktop' && focusedKey !== null) {
      const keys = focusKeys(drawn)
      const opensField = focusHint?.startsWith('type-') && keys.has(focusHint)
      if (!keys.has(focusedKey) || opensField) {
        const next = [focusHint, rowKeys[0]?.key, ...keys].find((k): k is string => !!k && keys.has(k)) ?? null
        focusedKey = next
        focusHint = null
        // After this hook returns, since a focus asked from inside a drawing's own hook cannot wait on it.
        if (next) later($, 0, () => $.ui.focus({ requestId: PANE, key: next }))
      }
    }

    return drawn
  })
}
