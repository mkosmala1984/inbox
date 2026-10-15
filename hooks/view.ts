// The inbox as every host draws it: the Needs you order and count, question
// handles, which rows are handed off or just closed, and the item status. The band, the pane,
// the sidebar line and row navigation all read this, so they agree.
// Pure: it reads only its arguments, and imports nothing from the engine.

import type {
  Closed,
  ClosedFinding,
  Finding,
  Item,
  LastAction,
  Ledger,
  LocalResult,
  PressKind,
  RowNote,
  Tab,
  Turns,
} from '../types'
import { ago, isLapsed, questionNumbers, reopenFinding, reopenItem } from './ledger'
import type { ClosedState } from './ledger'
import {
  actionId,
  capitalized,
  clipLabel,
  isAwaitingReply,
  isFixSent,
  isFoldingPress,
  isHandedOff,
  isPrRowId,
  isUndoable,
  noteText,
  retryOf,
  stepsOf,
} from './presses'
import type { HelpStep, RowPress } from './presses'

/** A question with more options than this shows the first 4 and [All N options]. */
const OPTIONS_FOLD_AT = 5
// The keys of a question's options and a row's steps, lettered as a multiple-choice
// question letters them. The digits switch tabs, and the letters left out are the
// keys of a Needs you row's other actions and of moving the selection.
export const CHOICE_KEYS = [...'abcfghilm']
/**
 * The dot between parts of a drawn line, as "title · 3m ago", set apart by spaces wider than a space. The one before
 * it is a figure space, which never breaks, so a wrapped line ends with the dot instead of starting with it.
 */
export const DOT = '\u2007·\u2002'

/** The Findings tab's groups, one per kind, in the order it lists them, and each kind's mark, drawn in its tone. */
export const FINDING_GROUPS: Record<Finding['kind'], { title: string; mark: string; tone: 'issue' | 'done' }> = {
  issue: { title: 'Issues', mark: '▲', tone: 'issue' },
  opportunity: { title: 'Opportunities', mark: '✦', tone: 'done' },
}

/** The mark before a row in a Closed fold, by how it ended. */
export const CLOSED_MARKS: Record<ClosedState, string> = { handled: '✓', dismissed: '✕', lapsed: '–' }

/** How many closed items each Closed fold lists. */
export const CLOSED_SHOWN = 3
/** How long a row that just closed stays in its place, and a row's note shows. */
export const SETTLED_MS = 5120
/** How long a row's buttons ignore clicks after it opens, so a double-click cannot land on one that just drew. */
export const PRESS_GUARD_MS = 400
/**
 * How long a press's message waits on its way to the agent before its row reads "Queued". A message to an idle agent
 * arrives within this, so its row goes straight to its outcome.
 */
export const QUEUED_AFTER_MS = 1000

/** Whether a press's message has waited on its way to the agent for QUEUED_AFTER_MS or more. */
export function isQueuedAt(last: LastAction | undefined, now: number): boolean {
  return last?.delivery?.state === 'queued' && now - last.at >= QUEUED_AFTER_MS
}

/** Whether a row opened at `openedAt` still ignores clicks. 0 means no click opened it, so nothing is guarded. */
export function isGuarded(openedAt: number, now: number): boolean {
  return openedAt > 0 && now - openedAt < PRESS_GUARD_MS
}

/** Whether the per-turn update is running, and the error to show, if any. */
export type ItemStatus = { isUpdating: boolean; error: string | null }

export type ViewInput = {
  ledger: Ledger
  /** Each row's last press, by row id. */
  lastActions: Record<string, LastAction>
  /** Each row's latest note, by row id. */
  notes: Record<string, RowNote>
  turns: Turns
  /** Per item id, steps a host adds beyond the item's own helps: the mod's "Open PR #N". */
  extraSteps: Record<string, HelpStep[]>
  /** How long after a close the view still lists the row as settled. The mod passes SETTLED_MS. */
  settleWindowMs: number
  status: ItemStatus
  now: number
}

/**
 * A handed-off row stays in its place, folded, and leaves the count. A settled
 * row just closed: it stays in its place with its outcome, `label`, and leaves
 * the count. `canUndo` when the person's own Done or Dismiss closed it.
 * `isQueued` once the answer that closed it has waited QUEUED_AFTER_MS without reaching the agent.
 */
export type RowState =
  | { is: 'open' }
  | { is: 'handedOff' }
  | { is: 'settled'; label: string; at: number; canUndo: boolean; isQueued: boolean; isLapsed: boolean }

/**
 * What a row says about its last press: "✓ Explained · 1m ago". While its message has waited QUEUED_AFTER_MS without
 * arriving it reads "Queued: Explain · 1m ago", and once it failed, "Not sent: <reason>" with the press [Try again]
 * repeats, if any. A Talk press reads
 * "Explaining…" until the agent's reply, so its ✓ claims only an explanation there is to read. A row a hand-off left
 * open after the agent's reply reads "Still open".
 * A Local press's result shows while pending, for SETTLED_MS once done,
 * and until the next press once failed. A newer note shows in their place for SETTLED_MS.
 */
export type Feedback =
  | { is: 'done'; label: string; at: number; isHandedStep?: true }
  | { is: 'working'; label: string; at: number }
  | { is: 'stillOpen'; at: number }
  | { is: 'queued'; label: string; at: number }
  | { is: 'notSent'; reason: string; retry: RowPress | null }
  | { is: 'local'; result: LocalResult }
  | { is: 'note'; note: RowNote['note']; at: number }

/**
 * How the inbox is drawn, which decides some of its words: the mod in the Claude Code terminal or the desktop
 * app's pane. GLOSSARY.md defines it.
 */
export type Look = 'terminal' | 'desktop'

export type ActionView = {
  press: RowPress
  /** "Explain", or "Explain again" when the row's last action was this one. */
  label: string
  kind: PressKind
  /** The option Claude recommended. */
  isPrimary: boolean
  /** An option behind [All N options]. */
  isFolded: boolean
  /** Reply, Explain, Discuss or Dismiss: drawn after the row's answers and main action, as quieter text. */
  isFollowUp: boolean
  /** The key that presses it, where the action has a fixed one. Answers and steps take letters in order instead. */
  hotkey?: string
}

export type RowView = {
  id: string
  type: 'question' | 'task' | 'finding'
  /** "1)" for a question a typed number answers now, "•" for any other row. */
  handle: string
  title: string
  at: number | null
  item: Item | null
  finding: Finding | null
  /** The item's own steps, then the host's extra ones. */
  steps: HelpStep[]
  state: RowState
  feedback: Feedback | null
  /** Every action the row offers, every option included, in the order `actionsOf` sets. Key letters are each renderer's. */
  actions: ActionView[]
}

export type InboxView = {
  needsYou: {
    /** Open questions, and open tasks that are not handed off. */
    count: number
    questions: RowView[]
    tasks: RowView[]
    /** Every close the ledger keeps, newest first, settled rows included. */
    closed: { questions: Closed[]; tasks: Closed[] }
  }
  /** Newest first. The count leaves out handed-off findings. `closed` is every close the ledger keeps, newest first. */
  findings: { count: number; rows: RowView[]; closed: ClosedFinding[] }
  status: ItemStatus
}

/** Every row a view lists: questions, tasks, then findings. */
export function allRows(v: InboxView): RowView[] {
  return [...v.needsYou.questions, ...v.needsYou.tasks, ...v.findings.rows]
}

/** The ids of the rows among `rows` that just closed. */
export function settledRowIds(rows: RowView[]): string[] {
  return rows.filter(r => r.state.is === 'settled').map(r => r.id)
}

/** What a Closed fold lists: its closes, without the rows drawn as settled right now, up to CLOSED_SHOWN. */
export function closedShown<T extends { id: string }>(closed: T[], drawnSettled: ReadonlySet<string>): T[] {
  return closed.filter(d => !drawnSettled.has(d.id)).slice(0, CLOSED_SHOWN)
}

/** How many closes a Closed fold counts: all it keeps, without the rows drawn as settled right now. */
export function closedTotal(closed: { id: string }[], drawnSettled: ReadonlySet<string>): number {
  return closed.filter(d => !drawnSettled.has(d.id)).length
}

/** A Closed fold's label, which counts every close, not only the ones it lists. */
export function foldLabel(total: number): string {
  return `${total} closed`
}

/** The line under a Closed fold's list for the closes it leaves out, or null when it lists them all. */
export function earlierLabel(total: number, shown: number): string | null {
  return total > shown ? `${total - shown} earlier` : null
}

/** An age for a side column: "12m", "3h", or "now". */
export function shortAgo(ms: number): string {
  const age = ago(ms)

  return age === 'just now' ? 'now' : age.replace(/ ago$/, '')
}

/**
 * The line in place of a group's rows while it has none open, as "No open questions". A tab keeps every group, so
 * it keeps its shape whatever is open.
 */
export function groupEmptyText(title: string): string {
  return `No open ${title.toLowerCase()}`
}

/** The line above a demo's rows. */
export const DEMO_NOTICE = 'Sample entries. Presses send nothing.'

const UPDATE_FAILED = 'Last update failed. Items from that reply may be missing.'
const UPDATE_RETRIES = ' It retries after your next message.'

/**
 * The open items in the order Needs you lists them: the newest reply's first, and each reply's in the order the
 * agent asked them, which is id order. Tasks follow the same rule, since a reply's tasks often depend on each other.
 */
function needsYouOrder(ledger: Ledger): { questions: Item[]; tasks: Item[] } {
  const newestReplyFirst = (kind: Item['kind']) =>
    ledger.items.filter(i => i.kind === kind).sort((a, b) => b.turn - a.turn)

  return { questions: newestReplyFirst('question'), tasks: newestReplyFirst('task') }
}

/**
 * Row `id`'s feedback: its note while the note is newer than its last press and
 * younger than SETTLED_MS; else its Local result while that shows; else its
 * last Talk, Hand-off or Mark press, by where its message is.
 */
export function feedbackOf(
  id: string,
  last: LastAction | undefined,
  note: RowNote | undefined,
  turns: Turns,
  now: number,
): Feedback | null {
  const result = last?.result
  if (note && now - note.at < SETTLED_MS && note.at >= Math.max(last?.at ?? 0, result?.at ?? 0))
    return { is: 'note', note: note.note, at: note.at }
  if (result && (result.state !== 'done' || now - result.at < SETTLED_MS)) return { is: 'local', result }
  if (!last || last.kind === 'local') return null
  const delivery = last.delivery
  if (isQueuedAt(last, now)) return { is: 'queued', label: last.text, at: last.at }
  if (delivery?.state === 'failed') return { is: 'notSent', reason: delivery.reason, retry: retryOf(id, last) }
  const isAwaiting = isAwaitingReply(last, turns)
  const working = WORKING_LABELS[last.action]
  if (last.kind === 'talk' && working && isAwaiting) return { is: 'working', label: working, at: last.at }
  // A review thread or check waits on GitHub instead, so only a question, task or finding row reads it.
  if (!isAwaiting && !isPrRowId(id) && isFoldingPress(id, last)) return { is: 'stillOpen', at: last.at }

  const isHandedStep = last.kind === 'handoff' && last.action.startsWith('step-')

  return {
    is: 'done',
    label: DONE_LABELS[last.action]?.(last.text) ?? last.text,
    at: last.at,
    ...(isHandedStep ? { isHandedStep: true as const } : {}),
  }
}

/**
 * What a row reads after a ✓ once a press went through, in the past tense: "Addressed", not "Address". An answer
 * reads as the option chosen, and a step as its own label.
 */
/** The Fix button's label for a finding, which its settled and closed rows read as the choice made. */
const fixLabel = (f: Pick<Finding, 'kind'>) => (f.kind === 'opportunity' ? 'Do it' : 'Fix')

/** What a Talk press reads while the agent's reply is still to come. */
const WORKING_LABELS: Record<string, string> = {
  explain: 'Explaining…',
  discuss: 'Discussing…',
  'thread-discuss': 'Discussing…',
  'thread-draft': 'Drafting a reply…',
}

const DONE_LABELS: Record<string, (text: string) => string> = {
  address: () => 'Handed off',
  discuss: () => 'Discussed',
  explain: () => 'Explained',
  dismiss: () => 'Dismissed',
  type: () => 'Replied',
  'thread-address': () => 'Addressed',
  'thread-discuss': () => 'Discussed',
  'thread-draft': () => 'Drafted a reply',
  'pr-conflicts': () => 'Asked to resolve conflicts',
  'pr-merge': () => 'Asked to merge',
  // "Address all 3 threads"
  'pr-address-all': text => text.replace(/^Address\b/, 'Addressed'),
}

/** Feedback that reports a failure, which a row draws in red. */
export function isFailure(f: Feedback | null): boolean {
  return f?.is === 'notSent' || (f?.is === 'local' && f.result.state === 'failed')
}

/** Feedback that reads with its age, in its place on the row's top line: a press's ✓, or where its message is. */
export function hasAge(f: Feedback): f is Extract<Feedback, { is: 'done' | 'working' | 'stillOpen' | 'queued' }> {
  return f.is === 'done' || f.is === 'working' || f.is === 'stillOpen' || f.is === 'queued'
}

// Where a copied command runs. The desktop app's composer is not known to take "!" for shell mode.
const runIt = (look: Look) =>
  look === 'terminal' ? 'Run it in a terminal, or type ! and paste.' : 'Run it in Terminal.'
const VERBS = {
  open: { pending: 'Opening', done: 'Opened', failed: 'open' },
  copy: { pending: 'Copying', done: 'Copied', failed: 'copy' },
}

/**
 * A Local result as its row reads it: "Opening .env…", "✓ Copied the key ·
 * Opened .env", or "Could not open .env: it no longer exists". Several PRs
 * one step opens read as one count, "✓ Opened 3 PRs".
 */
function localText(r: LocalResult, look: Look): string {
  const isPrs =
    r.parts.length > 1 && r.parts.every(p => p.kind === 'open' && p.error === null && /^PR #\d+$/.test(p.name))
  const parts = isPrs ? [{ ...r.parts[0]!, name: `${r.parts.length} PRs` }] : r.parts
  if (r.state === 'pending') return `${parts.map(p => `${VERBS[p.kind].pending} ${p.name}`).join(DOT)}…`
  const text = parts
    .map(p =>
      p.error === null ? `${VERBS[p.kind].done} ${p.name}` : `Could not ${VERBS[p.kind].failed} ${p.name}: ${p.error}`,
    )
    .join(DOT)
  if (r.state === 'failed') return text
  const isCommand = parts.some(p => p.kind === 'copy' && p.isCommand)

  return `✓ ${text}${isCommand ? `. ${runIt(look)}` : ''}`
}

/** Feedback as a row reads it, before any age. */
export function feedbackText(f: Feedback, look: Look): string {
  switch (f.is) {
    case 'note':
      return noteText(f.note)
    case 'local':
      return localText(f.result, look)
    case 'queued':
      return `Queued: ${f.label}`
    case 'notSent':
      return `Not sent: ${f.reason}`
    case 'done':
      // A step's own label is an instruction, as "Run load script": "✓ Run load script" would read as run. A row whose
      // handle is the ✓ draws the label alone, as its ✓ already says the step went to the agent.
      return f.isHandedStep ? `✓ Handed off: ${f.label}` : `✓ ${f.label}`
    case 'working':
      return f.label
    case 'stillOpen':
      return 'Still open'
  }
}

/** A step's kind: one that asks Claude to run a command hands the row off; the rest open or copy. */
function stepKind(step: HelpStep): PressKind {
  return step.step.some(h => h.kind === 'run') ? 'handoff' : 'local'
}

/** The inbox's tabs in order, as every look names them and the keys that switch to them. */
export const TABS: readonly { id: Tab; label: string; hotkey: string }[] = [
  { id: 'needsYou', label: 'Needs you', hotkey: '1' },
  { id: 'findings', label: 'Findings', hotkey: '2' },
  { id: 'prs', label: 'PRs', hotkey: '3' },
]
/** The tabs whose rows come from the ledger. The PRs tab's rows come from GitHub. */
export const ROW_TABS = TABS.filter((t): t is (typeof TABS)[number] & { id: 'needsYou' | 'findings' } => t.id !== 'prs')

/** What an empty tab says, with the agent named, as "Claude". */
export function emptyText(tab: 'needsYou' | 'findings', agent: string): { title: string; hint: string } {
  return tab === 'needsYou'
    ? { title: 'Nothing needs you.', hint: `${agent}'s questions and the tasks only you can do show up here.` }
    : { title: 'No findings yet', hint: `${agent} flags issues and opportunities it spots beyond your task.` }
}

const FOLLOW_UPS: ReadonlySet<RowPress['action']> = new Set(['type', 'explain', 'discuss', 'dismiss'])
const ACTION_KEYS: Partial<Record<RowPress['action'], string>> = {
  done: 'd',
  address: 'a',
  type: 't',
  explain: 'e',
  discuss: 'e',
  dismiss: 'x',
}

/**
 * A row's actions in the order the pane and the tab draw them, each labeled
 * "… again" when the row's last press, other than an open or copy, was that action.
 * A settled row offers only Undo, and only after the person's own Done or Dismiss.
 */
function actionsOf(
  row: { id: string; item: Item | null; finding: Finding | null; steps: HelpStep[] },
  last: LastAction | undefined,
  state: RowState,
): ActionView[] {
  const { id, item, steps } = row
  const action = (
    press: RowPress,
    label: string,
    kind: PressKind,
    flags: Partial<Pick<ActionView, 'isPrimary' | 'isFolded'>> = {},
  ): ActionView => ({
    press,
    // The type action opens a field for new words each time, an open or copy
    // only shows its result, and a press whose message failed did nothing, so none reads "again".
    label:
      press.action !== 'type' &&
      last?.kind !== 'local' &&
      last?.delivery?.state !== 'failed' &&
      last?.action === actionId(press)
        ? `${label} again`
        : label,
    kind,
    isPrimary: flags.isPrimary ?? false,
    isFolded: flags.isFolded ?? false,
    isFollowUp: FOLLOW_UPS.has(press.action),
    ...(ACTION_KEYS[press.action] ? { hotkey: ACTION_KEYS[press.action] } : {}),
  })
  if (state.is === 'settled') return state.canUndo ? [action({ action: 'undo', id }, 'Undo', 'view')] : []
  const stepActions = steps.map((s, n) => action({ action: 'step', id, step: n, label: s.label }, s.label, stepKind(s)))
  if (!item)
    return [
      // Only the label names the kind. The press and the message it sends are Address's for both.
      action({ action: 'address', id }, row.finding ? fixLabel(row.finding) : 'Fix', 'handoff'),
      action({ action: 'discuss', id }, 'Discuss', 'talk'),
      action({ action: 'type', id, text: '' }, 'Reply', 'handoff'),
      action({ action: 'dismiss', id }, 'Dismiss', 'mark'),
    ]
  if (item.kind === 'task')
    return [
      ...stepActions,
      action({ action: 'done', id }, 'Done', 'mark'),
      action({ action: 'type', id, text: '' }, 'Reply', 'handoff'),
      action({ action: 'explain', id }, 'Explain', 'talk'),
    ]
  const isFolding = item.options.length > OPTIONS_FOLD_AT
  // The recommended answer leads, so it is the first one read and never folded away.
  const options =
    item.rec && item.options.includes(item.rec) ? [item.rec, ...item.options.filter(o => o !== item.rec)] : item.options

  return [
    ...options.map((option, n) =>
      action({ action: 'answer', id, option }, clipLabel(option, 32), 'mark', {
        isPrimary: option === item.rec,
        isFolded: isFolding && n >= OPTIONS_FOLD_AT - 1,
      }),
    ),
    ...stepActions,
    action({ action: 'type', id, text: '' }, 'Reply', 'mark'),
    action({ action: 'explain', id }, 'Explain', 'talk'),
    action({ action: 'dismiss', id }, 'Dismiss', 'mark'),
  ]
}

/**
 * A list's entry as a look draws it: an open row as its adapter builds it, or a row that just closed, which keeps
 * its place and cannot be selected.
 */
export type DrawnEntry<R> = { row: R } | { settled: RowView; state: Extract<RowState, { is: 'settled' }> }

/** The view's lists as a look draws them, and each tab's open rows in order, which the selection moves over. */
export type DrawnLists<R> = {
  questions: DrawnEntry<R>[]
  tasks: DrawnEntry<R>[]
  findings: DrawnEntry<R>[]
  /** `findings` split by kind, in `FINDING_GROUPS` order. Every kind has a group, empty or not. */
  findingGroups: { kind: Finding['kind']; title: string; entries: DrawnEntry<R>[] }[]
  byTab: { needsYou: R[]; findings: R[] }
}

/**
 * The view's lists as a look draws them. A row that just closed shows in place while `isSettledDrawn` says so,
 * and is left out after. `toRow` builds an open row, or returns null to leave it out.
 */
export function drawnLists<R>(
  v: InboxView,
  isSettledDrawn: (id: string) => boolean,
  toRow: (r: RowView) => R | null,
): DrawnLists<R> {
  const entries = (rows: RowView[]) =>
    rows.flatMap((r): DrawnEntry<R>[] => {
      if (r.state.is === 'settled') return isSettledDrawn(r.id) ? [{ settled: r, state: r.state }] : []
      const row = toRow(r)
      return row === null ? [] : [{ row }]
    })
  const questions = entries(v.needsYou.questions)
  const tasks = entries(v.needsYou.tasks)
  const findingGroups = (Object.keys(FINDING_GROUPS) as Finding['kind'][]).map(kind => ({
    kind,
    title: FINDING_GROUPS[kind].title,
    entries: entries(v.findings.rows.filter(r => r.finding?.kind === kind)),
  }))
  const findings = findingGroups.flatMap(g => g.entries)

  return {
    questions,
    tasks,
    findings,
    findingGroups,
    byTab: { needsYou: [...rowsIn(questions), ...rowsIn(tasks)], findings: rowsIn(findings) },
  }
}

export function entryId(x: DrawnEntry<{ id: string }>): string {
  return 'row' in x ? x.row.id : x.settled.id
}

/** A row in its tab's drawn order, and whether it still waits on the person. */
export type RowWait = { id: string; isWaiting: boolean }

/** The Needs you and Findings rows in drawn order. A row that just closed is among them, as not waiting. */
export function listWaits(v: InboxView): { needsYou: RowWait[]; findings: RowWait[] } {
  const lists = drawnLists(
    v,
    () => true,
    r => r,
  )
  const waits = (entries: DrawnEntry<RowView>[]) =>
    entries.map(x =>
      'row' in x ? { id: x.row.id, isWaiting: x.row.state.is === 'open' } : { id: x.settled.id, isWaiting: false },
    )

  return { needsYou: waits([...lists.questions, ...lists.tasks]), findings: waits(lists.findings) }
}

/**
 * The row a tab draws open while no row is chosen there, as before any row was opened or after a press closed the last
 * waiting row: its first row that still waits on the person. A handed-off row stays collapsed until clicked, and with
 * none waiting no row is open.
 */
export function firstWaiting(rows: RowWait[]): string | null {
  return rows.find(r => r.isWaiting)?.id ?? null
}

/**
 * The row a tab that drew its first waiting row open keeps open once the rows `added` arrive: its first waiting row
 * among the rest, so a row that arrives above does not close the one the person is reading. Null when none of the
 * rest waits, and the tab then opens a new row.
 */
export function keptOpen(rows: RowWait[], added: readonly string[]): string | null {
  return firstWaiting(rows.filter(r => !added.includes(r.id)))
}

/**
 * The row to open once the open row `closedId` was answered, closed or handed off: the next row in `rows` that still
 * waits on the person, else the nearest one before it. Null when none waits, or when `rows` lacks `closedId`.
 */
export function rowAfterClose(rows: RowWait[], closedId: string): string | null {
  const at = rows.findIndex(r => r.id === closedId)
  if (at < 0) return null

  return (
    (
      rows.slice(at + 1).find(r => r.isWaiting) ??
      rows
        .slice(0, at)
        .reverse()
        .find(r => r.isWaiting)
    )?.id ?? null
  )
}

/** A list's open rows in order. */
export function rowsIn<R>(entries: DrawnEntry<R>[]): R[] {
  return entries.flatMap(x => ('row' in x ? [x.row] : []))
}

/** The ids of the rows that just closed a list draws, which its Closed fold leaves out. */
export function settledIn(entries: DrawnEntry<unknown>[]): Set<string> {
  return new Set(entries.flatMap(x => ('settled' in x ? [x.settled.id] : [])))
}

/** A row action drawn as a key: `more` holds the follow-ups, and `keys` the rest. */
export type ActionKey = { slot: 'action'; action: ActionView; hotkey: string }

/**
 * A row's key, in the order every look draws them. `retry` repeats a press whose message failed to send, as the
 * kind of the action it repeats. `choice` is an option or a step, lettered in order while letters last.
 * `allOptions` shows a question's folded options.
 */
export type PlannedKey =
  | { slot: 'retry'; press: RowPress; kind: PressKind }
  | {
      slot: 'choice'
      action: ActionView & { press: Extract<RowPress, { action: 'answer' | 'step' }> }
      hotkey?: string
    }
  | { slot: 'allOptions'; count: number }
  | ActionKey

/**
 * A row's actions as keys. `keys` finish the row: [Try again] first when a send failed, then options and steps,
 * the first 9 shown on letters, then Done for a task and Address for a finding. `more` are the other ways to
 * respond: your own words, Discuss, and Dismiss. Where the look `hasKeys`, `hidden` keeps Explain's key without
 * drawing it, so it does not crowd the row's answers. Desktop takes no keys, so it draws Explain in `more`. A question's folded options show only with `isAllShown`, and until then [All N options] follows
 * the last option shown.
 */
export function rowKeyPlan(
  r: RowView,
  isAllShown: boolean,
  hasKeys: boolean,
): { keys: PlannedKey[]; more: ActionKey[]; hidden: ActionKey[] } {
  const shown = r.actions.filter(a => isAllShown || !a.isFolded)
  const folded = r.actions.length - shown.length
  const lastOption = shown.map(a => a.press.action).lastIndexOf('answer')
  const keys: PlannedKey[] = []
  const more: ActionKey[] = []
  const hidden: ActionKey[] = []
  const retry = r.feedback?.is === 'notSent' ? r.feedback.retry : null
  if (retry) {
    const kind = r.actions.find(a => actionId(a.press) === actionId(retry))?.kind ?? 'talk'
    keys.push({ slot: 'retry', press: retry, kind })
  }
  let letters = 0
  for (const [n, a] of shown.entries()) {
    const { press } = a
    if (press.action === 'answer' || press.action === 'step') {
      const hotkey = letters < CHOICE_KEYS.length ? { hotkey: CHOICE_KEYS[letters++]! } : {}
      keys.push({ slot: 'choice', action: { ...a, press }, ...hotkey })
      if (n === lastOption && folded > 0)
        keys.push({ slot: 'allOptions', count: r.actions.filter(x => x.press.action === 'answer').length })
    } else if (a.hotkey)
      (press.action === 'explain' && hasKeys ? hidden : a.isFollowUp ? more : keys).push({
        slot: 'action',
        action: a,
        hotkey: a.hotkey,
      })
  }

  return { keys, more, hidden }
}

export function inboxView({
  ledger,
  lastActions,
  notes,
  turns,
  extraSteps,
  settleWindowMs,
  status,
  now,
}: ViewInput): InboxView {
  const isSettling = (at: number) => now - at < settleWindowMs
  const isOpen = (id: string) => ledger.items.some(i => i.id === id) || ledger.findings.some(f => f.id === id)
  // A row that just closed is put back among the open ones, so it is ordered where it stood.
  const settledItems = new Map(
    ledger.closed.filter(d => d.item && isSettling(d.at) && !isOpen(d.id)).map(d => [d.id, d] as const),
  )
  // A finding Fix sent already settled and moved to the Closed fold, so the agent's close does not list it again.
  const isFixSettled = (id: string) => {
    const last = lastActions[id]

    return isFixSent(last) && !isSettling(last.at)
  }
  const settledFindings = new Map(
    ledger.closedFindings
      .filter(f => isSettling(f.closedAt) && !isOpen(f.id) && !isFixSettled(f.id))
      .map(f => [f.id, f] as const),
  )
  const placed = [...settledFindings.keys()].reduce(reopenFinding, [...settledItems.keys()].reduce(reopenItem, ledger))
  const { questions, tasks } = needsYouOrder(placed)
  // The number the person's next prompt answers each question by, which only open questions have.
  const numbers = questionNumbers(ledger, ledger.turn + 1)
  const stateOf = (id: string): RowState => {
    const closed = settledItems.get(id) ?? settledFindings.get(id)
    if (closed) {
      const at = 'closedAt' in closed ? closed.closedAt : closed.at
      const last = lastActions[id]

      return {
        is: 'settled',
        label: capitalized(closed.outcome),
        at,
        canUndo: isUndoable(closed),
        // Dismissed, expired or closed by the agent: drawn muted, as the Closed fold draws it.
        isLapsed: isLapsed(closed),
        // Queued only while the answer press that closed the row waits to reach Claude. Claude's own close sends nothing.
        isQueued: closed.how === 'answered' && last?.kind === 'mark' && last.at === at && isQueuedAt(last, now),
      }
    }

    const last = lastActions[id]
    // Fix settles the row as an answer does, though the finding stays open until the agent closes it.
    const sent = ledger.findings.find(f => f.id === id)
    if (sent && isFixSent(last))
      return {
        is: 'settled',
        label: fixLabel(sent),
        at: last.at,
        canUndo: true,
        isQueued: isQueuedAt(last, now),
        isLapsed: false,
      }

    return isHandedOff(last, turns) ? { is: 'handedOff' } : { is: 'open' }
  }
  const rowOf = (row: Omit<RowView, 'state' | 'feedback' | 'actions'>): RowView => {
    const state = stateOf(row.id)

    return {
      ...row,
      state,
      feedback: state.is === 'settled' ? null : feedbackOf(row.id, lastActions[row.id], notes[row.id], turns, now),
      actions: actionsOf(row, lastActions[row.id], state),
    }
  }
  const itemRow = (item: Item): RowView => {
    const n = numbers.get(item.id)

    return rowOf({
      id: item.id,
      type: item.kind,
      // A question no typed number reaches takes a task's bullet: a "?" reads as a missing number.
      handle: n === undefined ? '•' : `${n})`,
      title: item.ask,
      at: item.at,
      item,
      finding: null,
      steps: stepsOf(item, extraSteps[item.id] ?? []),
    })
  }
  const questionRows = questions.map(itemRow)
  const taskRows = tasks.map(itemRow)
  const counted = [...questionRows, ...taskRows].filter(r => r.state.is === 'open')
  // Newest first within each kind, in the order the Findings tab groups them.
  const kinds = Object.keys(FINDING_GROUPS) as Finding['kind'][]
  const byGroup = (a: Finding, b: Finding) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind)
  const findingRows = [...placed.findings]
    // A finding Fix sent leaves the list once it has settled, for the Closed fold.
    .filter(f => !isFixSettled(f.id))
    .reverse()
    .sort(byGroup)
    .map(finding =>
      rowOf({
        id: finding.id,
        type: 'finding',
        handle: '•',
        title: finding.title,
        at: finding.at,
        item: null,
        finding,
        steps: [],
      }),
    )
  const closed = [...ledger.closed].reverse()
  // Listed in the Closed fold as the person's choice, while the ledger keeps them open for the agent to close. Like a
  // close, one counts from the press; each fold leaves out the rows it still draws settled.
  const fixesSent: ClosedFinding[] = ledger.findings
    .filter(f => isFixSent(lastActions[f.id]))
    .map(f => ({ ...f, how: 'answered', outcome: fixLabel(f), closedAt: lastActions[f.id]!.at }))

  return {
    needsYou: {
      count: counted.length,
      questions: questionRows,
      tasks: taskRows,
      closed: { questions: closed.filter(d => d.kind === 'question'), tasks: closed.filter(d => d.kind === 'task') },
    },
    findings: {
      count: findingRows.filter(r => r.state.is === 'open').length,
      rows: findingRows,
      closed: [...ledger.closedFindings, ...fixesSent].sort((a, b) => b.closedAt - a.closedAt),
    },
    status,
  }
}

/**
 * The per-turn update's status. A failure shows only once no update runs, since a running one may repair it. Its
 * text promises a retry only when the source retries a failed update.
 */
export function perTurnStatus(update: { isUpdating: boolean; isFailed: boolean; retries: boolean }): ItemStatus {
  return {
    isUpdating: update.isUpdating,
    error: update.isFailed && !update.isUpdating ? UPDATE_FAILED + (update.retries ? UPDATE_RETRIES : '') : null,
  }
}
