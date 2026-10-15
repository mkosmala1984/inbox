// The saved ledger and its writes, and the texts the models read: `guidanceText`, `systemText`, `buildPrompt`,
// `inboxText`, `carryText`, `closedText`, `answerNote`. Both hosts import it. AGENTS.md's rule for testing model-read text
// covers those texts.
//
// Claude only today: the stop text (`stopText`, `statusLine`), `dialogText`, the command rows (`readCommandRow`),
// and the transcript code, which imports a `claude-code` type. Step 5 of docs/plans/three-looks.md moves them out.

import type { SessionMessage } from 'claude-code'

import type { Card, Closed, ClosedFinding, Dialog, Finding, Help, Item, Ledger, Stop } from '../types'

export const EMPTY: Ledger = {
  card: null,
  items: [],
  closed: [],
  findings: [],
  closedFindings: [],
  prs: [],
  nextId: 1,
  turn: 0,
  batchTurn: 0,
}

const NL = '\n'
const MAX_OPEN = 20
/** Prompts after which an unanswered item is dropped as moot. */
const STALE_AFTER = 12
const MAX_CLOSED = 12
/** The outcome of an item left unanswered until it went stale. */
const EXPIRED = 'expired, unanswered'
const MAX_HELPS = 3
const MAX_FINDINGS = 30

/** The inbox model's protocol names the two kinds decide and do. */
const MODEL_KIND: Record<Item['kind'], 'decide' | 'do'> = { question: 'decide', task: 'do' }

/** Reads a kind the model wrote or an older version saved; anything but a task is a question. */
export function readKind(kind: string | null | undefined): Item['kind'] {
  return kind === 'task' || kind === 'do' ? 'task' : 'question'
}

/**
 * A ledger saved by an earlier version of the mod, in the current shape.
 * Findings were once saved as `notes`; items once had no time, and closed
 * items no kind or `how`, so an old closed item counts as a question. Closed
 * items were saved as `decided`, and kinds as `decide` and `do`. Closed
 * findings were once not kept.
 */
export function upgradeLedger(ledger: Ledger): Ledger {
  const { notes, decided, ...rest } = ledger as Ledger & { notes?: Finding[]; decided?: Ledger['closed'] }

  return {
    ...rest,
    findings: [...(rest.findings ?? []), ...(notes ?? [])],
    // reopenFinding puts these back, so a conversion added for findings must run on them too.
    closedFindings: rest.closedFindings ?? [],
    items: rest.items.map(upgradeItem),
    closed: (rest.closed ?? decided ?? []).map(d => ({
      ...d,
      kind: readKind(d.kind),
      how: d.how ?? howFromOutcome(d.outcome),
      ...(d.item ? { item: upgradeItem(d.item) } : {}),
    })),
  }
}

/** An open item in the current shape. Also run on the copy a close record keeps, which reopenItem puts back. */
function upgradeItem(item: Item): Item {
  return { ...item, kind: readKind(item.kind), at: item.at ?? null, rec: recommendedOption(item.options, item.rec) }
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * The option a recommendation names: the one whose words all appear in it,
 * the longest when several do. "Symlink into a PATH folder" names "Symlink
 * into PATH". Null when it names none, since a recommendation that is not one
 * of the answers came from the wrong field or from no recommendation at all.
 */
export function recommendedOption(options: string[], rec: string | null): string | null {
  if (!rec) return null
  const named = new Set(words(rec))
  let best: string | null = null
  for (const option of options) {
    const w = words(option)
    if (w.length > words(best ?? '').length && w.every(x => named.has(x))) best = option
  }
  // "A" names "A: Cancel button" by the letter or number the reply labeled it with.
  const label = (text: string) => text.match(/^\s*\(?([a-z]|\d{1,2})\s*[:.)]/i)?.[1]?.toLowerCase()
  const byLabel = /^\s*(?:option\s+)?([a-z]|\d{1,2})\s*[.!]?\s*$/i.exec(rec)?.[1]?.toLowerCase()

  return best ?? (byLabel ? (options.find(o => label(o) === byLabel) ?? null) : null)
}

/** How a closed item saved before `how` existed closed, read from its outcome's wording. */
function howFromOutcome(outcome: string): Closed['how'] {
  if (outcome === 'dismissed') return 'dismissed'
  if (outcome === EXPIRED) return 'expired'
  if (outcome === 'done' || outcome === 'you ran it') return 'done'
  if (outcome.startsWith(CLOSED_BY_CLAUDE)) return 'claude'

  return 'update'
}
/**
 * Commands that sign in or ask for a password. They need the person's own
 * terminal, so their button copies them instead of asking Claude to run them.
 * Each word counts only as a command or subcommand, as in `gh auth login`, so a
 * path or URL holding it, as in `curl https://x/login`, stays the agent's to run.
 */
const NEEDS_PERSON =
  /(?:^|[\s;&|])(?:login|logout|signin|sign-in|sudo|passwd|ssh-add|ssh-keygen)(?=[\s:]|$)|\binit --interactive\b/i

/**
 * Words a reply uses when only the person can run a command: their credentials, device or account, in English
 * or Polish. The inbox model sometimes marks a command the reply merely asks the person to run as theirs, so a
 * terminal step in a reply with none of these words is the agent's to run.
 */
const PERSON_ONLY_REASON =
  /credential|password|passphrase|secret|\btoken|\b2fa\b|\bmfa\b|\bdevice\b|phone|android|tablet|account|sign(?:ed)?[- ]?in|log(?:ged)?[- ]?in|only you|you hold|your (?:mac|machine|laptop|computer|keychain)|\bsudo\b|\bhas(?:ł|eł)|logowa|zaloguj|zalogowa|poświadcze|\bkont(?:o|a|u|em|ach)\b|telefon|urządzeni|tylko ty\b|tylko u ciebie/i

/** The inbox model's instructions in a host. */
export function systemText(host: Host): string {
  const band = host.band ? ` They always see how many items are in <open> and <findings> in ${host.band}.` : ''

  return `You keep a short ledger for a person who works with a coding agent across many parallel sessions. They glance at your ledger between tasks, or after time away, to see where this session stands. You read one exchange and update the ledger.

Input:
- <card>: the ledger before this exchange (may be empty)
- <open>: items still waiting on the person, as id | kind | label | ask | options | rec
- <findings>: findings the agent recorded for the person to review later, outside the current task, each with an id
- <decided>: items the person already settled, and how. Never add one of these again as NEW, even when the reply asks it again.
- <person>: what the person just sent, and the commands they ran themselves: "$ cmd" for a shell command, with its output, and "/name" for a slash command
- <activity>: what the agent did this turn (files edited, commands, URLs)
- <reply>: the agent's final reply
- <screen>: what the person has on screen besides the conversation.${band}

Answer with lines only, each starting with one of these keys. No other text.

GOAL: what this session is for, at most 12 words. Keep the previous goal unless the person clearly changed direction. "-" until the person has asked for something.
DONE: one finished outcome, at most 8 words. Up to 4 DONE lines, oldest first, keeping the most recent. Outcomes, not activity: "PR #12 opened", not "ran gh".
NOW: where the work stands at the end of this reply, at most 12 words. Name what it waits on, if anything. "-" when no work has started.
RUNNING: something still running that the person may open, as "name: URL or port". Dev servers, simulators, background jobs. Omit anything the agent stopped. Zero or more lines.
CLOSED: <id> | the outcome, at most 8 words, in one of three forms. When the person answered in <person>, write their answer. Otherwise write "done: <what the agent did>" when the work is done, or "no longer applies: <why>". An option the agent picked on its own, or an option the work made moot, is not the person's answer: write it in the "done:" or "no longer applies:" form. One line for each item in <open> the person answered in <person> (including "all recommended", "go", "yes to all", numbered answers), or that the reply or <activity> shows is done or no longer applies. A person asking what an item means has not answered it, and a reply explaining it does not close it. When <person> asks to run an item's command and the reply says it ran, that item is done. So is an item whose command the person ran themselves, per <person>, when its output shows it worked. An item that has nothing to do with this exchange stays open: being outside the current work does not make it no longer apply.
FIXED: <id> | the change that fixed it, at most 8 words. One line for each finding in <findings> whose problem the reply, <activity> or <person> shows was fixed by a change to the work. Only a change fixes a finding. When the person puts a finding off, sets it aside or says it does not matter, write no FIXED line: it stays open until they dismiss it.
ASKED: <id> | <item>
  For a finding in <findings> that a NEW line or an item in <open> asks the person about. item: "new N" for the Nth NEW line in your answer, or an id from <open>. The item takes the finding's place, so the person sees it once.
NEW: <kind> | <label> | <ask> | <options> | <rec>
  One line per thing in <reply> that waits on the person and is not already in <open> or <findings>. A finding the agent recorded is not NEW unless the reply asks the person to decide or do something about it now; then also write an ASKED line for it. When the reply restates, rewords or narrows an item in <open>, it is not new: add HELP lines to that item's id instead.
  kind: "decide" (a choice, approval, or information only the person has, explicitly put to them, without which the agent cannot go on with its task) or "do" (an action only the person can take, without which the agent cannot continue or finish: sign in, run a command needing their password, test on their device, reply to a teammate).
  label: the reply's own number or id for it ("1", "D3"), or "-".
  ask: plain words, readable without the reply, at most 12 words, or up to 16 when 12 would lose meaning. Keep the question's meaning and every alternative it names. Replace any term the reply coined with what it means. Name an item or finding by what it says, never by its id: the person does not see ids.
  options: the answers the person can pick, separated by " / ", at most 5 words each; "-" for kind "do". For kind "decide", always at least one, so one press can answer. Use the choices the reply offers, plus the answer it recommends when that is not one of them. When the reply offers none, predict the answers the person would most likely give: the yes and the no for an approval or a yes-or-no question ("Approve / Not yet"); the 1 to 3 likeliest answers to an open question, from the conversation; or, when the conversation suggests no answer, what the person would most likely ask the agent to do instead ("List the choices", "Pick one for me").
  rec: the option the reply states it recommends for this question ("I'd go with X", "I recommend X"), copied from options, or "-" when it states none for this question. A reason the reply gives for one answer is not a recommendation: it must say it recommends or prefers that answer.
  Skip: rhetorical questions; offers to continue ("Want me to start?") when continuing is the obvious default; FYIs; generic "let me know"; invitations to look at, try or check finished work ("Open X to see it", "reload to check") unless the agent waits on the person's verdict before going on; optional suggestions; anything the person already has on screen, per <screen>; questions asking the person to describe what they saw, did or meant, even when the answer would help diagnose a problem ("What happens when you click it?", "Which file did you mean?"). The person answers those by replying.
UPDATE: <id> | <options> | <rec>
  For a "decide" item in <open> when the reply now offers it different answers, or states a recommendation for it that <open> does not show. options: the answers the person can now pick, as in NEW, or "-" to keep them. rec: as in NEW, or "-" to keep it. Rewording the question is not a change.
HELP: <item> | <kind> | <value> | <name>
  A step that does part of an item's work in one press, when the reply or activity already spells it out: the file to edit, the text to paste, the command to run, the page to visit. Not background reading. Up to 3 per item, most useful first.
  item: "new N" for the Nth NEW line in your answer, or an id from <open>.
  kind and value:
    open | a file or folder the person needs to open or edit, the path as written
    copy | text for the person to paste into a file or form, never a command: "block N" for the code block marked [block N] in <reply>, or one line of text
    run | a shell command the reply asks the person to run or approve: "block N" or the command
    terminal | a shell command the reply says only the person can run, because it needs their credentials, password, device or account: "block N" or the command
    link | an https URL the person needs to visit
  name: what a copy, command or link is, at most 3 words ("settings snippet", "removal command", "token page"), or "-".
  Use only paths, commands, text and URLs that appear in <reply> or <activity>. Never invent one.
TODO: <work>
  For a todo in <person>: work the person sets aside for later, as in "todo: X", and the reply leaves undone. work: at most 12 words, worded to follow "Ready to start on".

Write plainly. No jargon, no filler, no markdown.`
}

/** What the agent reads at the start of every session: what the inbox shows, and when to record and close. */
export function guidanceText(host: Host): string {
  return `# Inbox
${host.intro}

When you ask the user to decide something, say which option you recommend and why, in one clause ("I'd go with B: it keeps the old API"). If you cannot recommend one, say what would decide it.

A finding is something you noticed that deserves the user's attention but is outside the current task: a bug, a risk, missing tests, tech debt, or a chance to improve something. Record it with mcp__inbox__record_finding the moment you notice it, then go on with the task; fixing it waits until the user asks. Record one too at two moments that are easy to pass over while focused on the task:
- You work around a problem instead of fixing it, such as copying files by hand because a tool does not reach them.
- Part of your change could not be tested or verified.
State those two in your reply as well. Mention any other finding only when it bears on what the user asked.

The latest "inbox:" text beside the user's prompt is the current state. It lists every open item and finding with its id, such as [i35] or [f12], and anything it does not list is closed. Check it before telling the user that something is open or waits on them. The ids are for the inbox tools only. The user never sees them, so never write one to the user, not even in parentheses: name an item or finding by what it says, as "the deploy task" or "the migration finding".

Close with mcp__inbox__close:
- When the user's message answers an open item, close it first, before other work, with their answer.
- When an item or finding is done or no longer applies, close it with a short reason, without waiting to be asked.
The answer to a question is the user's to give. Close a question with their answer, or once it no longer applies, and never with an answer of your own.`
}

/** The title of the block that says where the session stands, at session start and after a compaction. */
export const START_TITLE =
  'inbox: where this session stands, as of the last reply. An "inbox:" text beside a later prompt replaces this.'

const CATCH_UP =
  'The ledger below may have missed turns. Write a CLOSED line for every item in <open> that the conversation shows answered, done, dealt with, or no longer relevant, and a FIXED line for every finding in <findings> that it shows was fixed. Add as NEW only what still waits on the user and is not already in <open> or <findings>.'

/**
 * Asks a fork of the main conversation to bring the ledger up to date at once,
 * for turns the per-turn update missed.
 */
export function catchUpPrompt(host: Host, ledger: Ledger, screen: string): string {
  return [
    'Pause the task. Do not use tools. Instead, act as the ledger keeper described below, over this whole conversation.',
    `Treat the whole conversation as the exchange. ${CATCH_UP}`,
    ...ledgerBlocks(ledger),
    `<screen>${NL}${screen}${NL}</screen>`,
    'Code blocks here carry no [block N] marker, so a copy HELP must be one line of text.',
    '',
    systemText(host),
  ].join(NL)
}

/**
 * The catch-up as an ordinary call over the transcript, for a conversation
 * this process cannot fork yet. systemText goes in the call's system prompt.
 */
export function transcriptCatchUpPrompt(ledger: Ledger, screen: string, transcript: string): string {
  return [
    `Treat the conversation in <conversation> as the exchange. Its start may be cut. ${CATCH_UP}`,
    ...ledgerBlocks(ledger),
    `<conversation>${NL}${numberBlocks(transcript)}${NL}</conversation>`,
    `<screen>${NL}${screen}${NL}</screen>`,
  ].join(NL)
}

/** What the agent did with one tool call, as an activity line; null for a call the ledger has no use for. */
export function toolActivity(tool: string, input: Record<string, unknown>): string | null {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Bash':
      return `${input.run_in_background ? 'started in background' : 'ran'}: ${text('command').slice(0, 140)}`
    case 'Edit':
    case 'Write':
      return `edited ${text('file_path')}`
    case 'Skill':
      return `used skill ${text('skill')}`
    case 'Agent':
      return `started agent: ${text('description')}`
  }

  return tool.startsWith('mcp__') ? `called ${tool.slice(5)}` : null
}

/** What the agent asked in a question dialog and how it was answered, as an activity line. */
export function dialogLine(answer: string, isTimedOut: boolean): string {
  // A dialog that resolved on its own while the person was away holds no answer of theirs.
  const how = isTimedOut
    ? 'it timed out while the user was away, so the user did not answer; it went on with'
    : 'answer'

  return `asked the user in a dialog; ${how}: ${answer.slice(0, 400)}`
}

const TRANSCRIPT_MAX = 80_000
const MESSAGE_MAX = 6000

/**
 * The conversation as the transcript catch-up reads it: the person's messages
 * and commands, the agent's replies and what it did. Only the most recent
 * part that fits is kept, since what still waits is near the end. Rows this
 * mod added beside a prompt, which start with "inbox:", are left out.
 */
export function transcriptText(messages: SessionMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = m.text.trim()
    if (m.role === 'user') {
      if (!text || text.startsWith('inbox:')) continue
      const row = readCommandRow(text)
      const line = row ? commandRowLine(row) : clip(text, MESSAGE_MAX)
      if (line) lines.push(`Person: ${line}`)
      continue
    }
    if (text) lines.push(`Agent: ${clip(text, MESSAGE_MAX)}`)
    for (const use of m.toolUses) {
      const timedOut = typeof (use.result as { afkTimeoutMs?: unknown } | undefined)?.afkTimeoutMs === 'number'
      const line =
        use.tool === 'AskUserQuestion' ? dialogLine(use.text ?? '', timedOut) : toolActivity(use.tool, use.input)
      if (line) lines.push(`Agent ${line}`)
    }
  }
  const kept: string[] = []
  let size = 0
  for (const line of lines.reverse()) {
    size += line.length + 1
    if (size > TRANSCRIPT_MAX) {
      kept.push('(earlier conversation left out)')
      break
    }
    kept.push(line)
  }

  return kept.reverse().join(NL)
}

export type Exchange = {
  /** What the person typed; null when something else started the turn. */
  person: string | null
  /** What started the turn when the person didn't (a task notification, a peer). */
  trigger: string | null
  activity: string[]
  reply: string
  /** The person-prompt count when the reply was written. */
  turn: number
  /** The item button the person pressed to send this turn's prompt, if any. */
  press: Press | null
  /** What the person has on screen besides the conversation, from screenText. */
  screen: string
}

/** A prompt the mod sent for an item: an answer, an Explain, a Run, or the message for a Done. */
export type Press = { id: string; action: 'answer' | 'explain' | 'run' | 'done' }

export type Update = {
  card: Card
  closed: { id: string; outcome: string }[]
  added: (Omit<Item, 'id' | 'turn' | 'at' | 'helps'> & { helps: Help[] })[]
  /** Helps for items already open. */
  helped: { id: string; help: Help }[]
  /** New options or a new recommendation for open questions. Null keeps what the question has. */
  updated: { id: string; options: string[] | null; rec: string | null }[]
  /** Findings an item now asks about: an open item's id, or the place of a NEW item in `added`. */
  asked: { id: string; item: string | number }[]
  /** Work the person set aside for later, from TODO lines. Each becomes a question about starting it. */
  todos: string[]
}

const FENCE = /```[^\n]*\n([\s\S]*?)```/g

/** The reply's fenced code blocks, in the order buildPrompt numbers them. */
function codeBlocks(reply: string): string[] {
  return [...reply.matchAll(FENCE)].map(m => (m[1] ?? '').replace(/\n$/, ''))
}

function numberBlocks(reply: string): string {
  let n = 0

  return reply.replace(FENCE, block => `[block ${(n += 1)}]${NL}${block}`)
}

/**
 * Checks one HELP line; null when it is unusable. A path, command, URL or line
 * of text must appear in `source`, the reply and activity, so the model cannot
 * invent one. A null source (a catch-up over the whole conversation) skips that.
 */
function readHelp(
  kind: string,
  value: string,
  name: string | null,
  blocks: string[],
  source: string | null,
): Help | null {
  const isQuoted = (text: string) => source === null || source.includes(text)
  // "block N" names a code block of the reply, already quoted; anything else is the value as written.
  const block = value.match(/^block\s+(\d+)$/i)
  const quoted = block ? (blocks[Number(block[1]) - 1] ?? '') : value.replace(/^`|`$/g, '')
  const isFromReply = (text: string) => block !== null || isQuoted(text)
  if (kind === 'open') {
    const path = value.replace(/^`|`$/g, '')
    // A bare word such as "migrations" can appear in any reply, so a path needs a "/", "." or "~" and must stand alone.
    const isPath = /[/.~]/.test(path) && !/^[a-z]+:/i.test(path) && path.length <= 300
    const standsAlone = (text: string) => new RegExp(`(?<![\\w.~-])${escaped(path)}(?![\\w/-])`).test(text)
    return isPath && (source === null || standsAlone(source)) ? { kind, path } : null
  }
  if (kind === 'copy') {
    return quoted.trim() !== '' && quoted.length <= 8000 && isFromReply(quoted) ? { kind, text: quoted, name } : null
  }
  if (kind === 'run' || kind === 'terminal') {
    const command = commandText(quoted)
    const isUsable = command !== '' && command.length <= 4000 && isFromReply(command)
    const isTheirs =
      NEEDS_PERSON.test(command) || (kind === 'terminal' && (source === null || PERSON_ONLY_REASON.test(source)))
    return isUsable ? { kind: isTheirs ? 'terminal' : 'run', command, name } : null
  }
  if (kind === 'link') {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && isQuoted(value) ? { kind, url: url.href, name } : null
    } catch {
      return null
    }
  }

  return null
}

/**
 * A HELP line's value and name, from the fields after its kind. A command can hold "|" itself, so the whole tail
 * is the value when the reply quotes it so; otherwise the last field is the name and the fields before it the value.
 */
function helpFields(tail: string[], source: string | null): { help: string; name: string | null } {
  const whole = tail.join('|').trim()
  if (tail.length <= 1 || (source !== null && source.includes(commandText(whole.replace(/^`|`$/g, '')))))
    return { help: whole, name: null }

  return { help: tail.slice(0, -1).join('|').trim(), name: dash(tail.at(-1)) }
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A command as written, without surrounding space or a leading `!`. */
function commandText(text: string): string {
  return text.trim().replace(/^!\s*/, '')
}

/** The command a help runs or copies, so a copy of a command yields to its command button. */
function commandOf(help: Help): string | null {
  if (isCommand(help)) return help.command
  if (help.kind === 'copy') return commandText(help.text)

  return null
}

function isCommand(help: Help): help is Extract<Help, { kind: 'run' | 'terminal' }> {
  return help.kind === 'run' || help.kind === 'terminal'
}

/** What a help acts on, without the name the model gave it, so one command under two names counts once. */
function helpTarget(help: Help): string {
  if (help.kind === 'open') return `open ${help.path}`
  if (help.kind === 'link') return `link ${help.url}`

  return `command ${commandOf(help)}`
}

function withHelp(helps: Help[], help: Help): Help[] {
  const command = commandOf(help)
  const kept = isCommand(help) ? helps.filter(h => h.kind !== 'copy' || commandOf(h) !== command) : helps
  // A copy and a run of one command share a target, so either covers the other.
  const isCovered = kept.some(h => helpTarget(h) === helpTarget(help))

  return isCovered || kept.length >= MAX_HELPS ? kept : [...kept, help]
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + ' …[cut]'
}

/** Clips text to its first `head` and last `max - head` characters, since a reply asks its questions at the end. */
function clipMiddle(text: string, max: number, head: number): string {
  if (text.length <= max) return text

  return `${text.slice(0, head)}${NL}…[cut]${NL}${text.slice(text.length - (max - head))}`
}

/** The ledger as the model reads it: the card, the open items and findings with their ids, and recently settled items. */
function ledgerBlocks(ledger: Ledger): string[] {
  const card = ledger.card
    ? [
        `GOAL: ${ledger.card.goal}`,
        ...ledger.card.done.map(d => `DONE: ${d}`),
        `NOW: ${ledger.card.now}`,
        ...ledger.card.running.map(r => `RUNNING: ${r}`),
      ].join(NL)
    : ''
  const open = ledger.items
    .map(
      i =>
        `${i.id} | ${MODEL_KIND[i.kind]} | ${i.label ?? '-'} | ${i.ask} | ${i.options.join(' / ') || '-'} | ${i.rec ?? '-'}`,
    )
    .join(NL)
  const findings = ledger.findings.map(f => `${f.id} | ${f.kind}: ${f.title}`).join(NL)
  // An expired item was never answered, so the reply may ask it again.
  const closed = ledger.closed
    .filter(d => d.how !== 'expired')
    .slice(-8)
    .map(d => `${d.ask} → ${outcomeText(d)}`)
    .join(NL)

  return [
    `<card>${NL}${card}${NL}</card>`,
    `<open>${NL}${open}${NL}</open>`,
    `<findings>${NL}${findings}${NL}</findings>`,
    `<decided>${NL}${closed}${NL}</decided>`,
  ]
}

export function buildPrompt(ledger: Ledger, ex: Exchange): string {
  const person = ex.person ?? `(The person sent nothing. The turn was started by: ${ex.trigger ?? 'unknown'}.)`

  return [
    ...ledgerBlocks(ledger),
    `<person>${NL}${clipMiddle(person, 4000, 1500)}${NL}</person>`,
    `<activity>${NL}${clipMiddle(ex.activity.join(NL), 2500, 500)}${NL}</activity>`,
    `<reply>${NL}${clipMiddle(numberBlocks(ex.reply), 12000, 4000)}${NL}</reply>`,
    `<screen>${NL}${ex.screen}${NL}</screen>`,
  ].join(NL)
}

/** The app the inbox runs in, as its texts name it: the agent, and where the person sees the inbox. */
export type Host = {
  agent: string
  surface: string
  /** Where the person always sees how many items and findings are open, besides the surface; null when only the surface shows them. */
  band: string | null
  /** Where the person sees the findings, within the surface. */
  findingsIn: string
  /** The first paragraph of `guidanceText`: what the inbox shows the person, and where. */
  intro: string
}

export const CLAUDE_CODE: Host = {
  agent: 'Claude',
  surface: 'the /inbox pane',
  band: 'a band above their prompt',
  findingsIn: 'the Findings tab of the /inbox pane',
  intro:
    "The inbox plugin shows the user what waits on them: your open questions and the tasks only they can do, in the /inbox pane, and your findings, in the pane's Findings tab. A band above their prompt shows only two counts: one for your questions and their tasks together, and one for your findings.",
}

/** The host's surface at the start of a sentence. */
function surfaceAtStart(host: Host): string {
  return host.surface.charAt(0).toUpperCase() + host.surface.slice(1)
}

/** What the person sees besides the conversation, as the ledger model reads it. `tab` is the tab shown, when the surface has tabs the model should hear about. */
export function screenText(host: Host, isOpen: boolean, tab: string | null): string {
  return isOpen
    ? `${surfaceAtStart(host)} is open beside the conversation, ${tab ? `on its ${tab} tab, ` : ''}listing every open item.`
    : `${surfaceAtStart(host)} is closed.`
}

/**
 * The open tasks a shell command the person ran completes: those whose run or
 * sign-in step is that exact command, so nothing closes on a guess.
 */
export function tasksRunBy(ledger: Ledger, command: string): Item[] {
  const typed = squash(command)

  return ledger.items.filter(i => i.kind === 'task' && i.helps.some(h => isCommand(h) && squash(h.command) === typed))
}

/** A transcript row of the person's own command, as session.append carries it. */
export type CommandRow =
  | { kind: 'shell'; command: string }
  | { kind: 'output'; stdout: string; stderr: string }
  | { kind: 'slash'; name: string; args: string }

/** Reads a `!` command, its output, or a slash command from a row's text; null for any other row. */
export function readCommandRow(text: string): CommandRow | null {
  const input = text.match(/^<bash-input>([\s\S]*)<\/bash-input>$/)
  if (input) return { kind: 'shell', command: (input[1] ?? '').trim() }
  const output = text.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout><bash-stderr>([\s\S]*?)<\/bash-stderr>/)
  if (output) return { kind: 'output', stdout: (output[1] ?? '').trim(), stderr: (output[2] ?? '').trim() }
  const name = text.match(/<command-name>\/?([^<\s]+)<\/command-name>/)
  if (name)
    return {
      kind: 'slash',
      name: name[1] ?? '',
      args: (text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? '').trim(),
    }

  return null
}

/** Slash commands that say nothing about the work. */
const QUIET_COMMANDS = new Set(['inbox', 'clear'])

/** A command row as the ledger model reads it in <person>; null for one that says nothing. */
export function commandRowLine(row: CommandRow): string | null {
  if (row.kind === 'shell') return `$ ${row.command}`
  if (row.kind === 'slash') return QUIET_COMMANDS.has(row.name) ? null : `/${row.name} ${row.args}`.trim()
  const output = [row.stdout, row.stderr].filter(Boolean).join(NL)

  return output ? `output: ${clip(output, 600)}` : null
}

function squash(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function dash(value: string | undefined): string | null {
  const v = (value ?? '').trim()

  return v === '' || v === '-' ? null : v
}

const KEY_LINE = /^\s*[-*]?\s*(GOAL|DONE|NOW|RUNNING|CLOSED|FIXED|ASKED|NEW|UPDATE|HELP|TODO)\s*:\s*(.*)$/

/**
 * Reads the model's line format; null when no known key appears. `source` is
 * the reply followed by the activity: HELP values must appear in it, and
 * "copy | block N" names its code blocks. Null skips both, so block copies drop.
 */
export function parseReply(text: string, source: string | null = null): Update | null {
  const blocks = source === null ? [] : codeBlocks(source)
  const card = { goal: '', done: [] as string[], now: '', running: [] as string[] }
  const closed: Update['closed'] = []
  const added: Update['added'] = []
  const helped: Update['helped'] = []
  const updated: Update['updated'] = []
  const helps: { target: string; help: Help }[] = []
  const asks: { id: string; target: string }[] = []
  const todos: string[] = []
  let seen = 0
  const lines = text.split(NL)
  // The model sometimes writes an answer, then a correction and a whole second answer. Each answer starts with
  // GOAL, so only the lines from the last GOAL on are the answer it settled on.
  const lastGoal = lines.findLastIndex(line => KEY_LINE.exec(line)?.[1] === 'GOAL')
  // The item each NEW line made, by its place among the NEW lines, as HELP's "new N" counts them.
  const newLines: (Update['added'][number] | undefined)[] = []

  for (const raw of lines.slice(Math.max(lastGoal, 0))) {
    const m = KEY_LINE.exec(raw)
    if (!m) continue
    seen += 1
    const key = m[1]
    // The model writes "-" for "nothing", for a whole value ("NOW: -") or one field ("NEW: do | - | - | - | -").
    const value = dash(m[2]) ?? ''
    if (key === 'GOAL') card.goal = value
    else if (key === 'NOW') card.now = value
    else if (key === 'DONE' && value) card.done.push(value)
    else if (key === 'RUNNING' && value) card.running.push(value)
    else if (key === 'CLOSED' || key === 'FIXED') {
      // CLOSED closes items and FIXED closes findings, so a finding the person only put off stays open.
      const [id, outcome] = value.split('|').map(s => s.trim())
      if (id && /^f\d/.test(id) === (key === 'FIXED')) closed.push({ id, outcome: outcome ?? '' })
    } else if (key === 'ASKED') {
      const [id, target] = value.split('|').map(s => s.trim())
      if (id && /^f\d+$/.test(id) && target) asks.push({ id, target })
    } else if (key === 'NEW') {
      // The recommendation is the last field. The model sometimes writes one answer after "|" instead of " / ".
      const fields = value.split('|')
      // The model sometimes leaves out the label, as in "NEW: do | Run the migration | - | - | -". A label
      // field holding a phrase, with no ask after it, is the ask.
      const isLabelSkipped = !dash(fields[2]) && /\s/.test((fields[1] ?? '').trim())
      const [kind, label, ask, ...rest] = (isLabelSkipped ? [fields[0], '-', ...fields.slice(1)] : fields).map(dash)
      const rec = rest.length > 1 ? rest.pop() : null
      if (!ask) {
        newLines.push(undefined)
        continue
      }
      const options = rest.flatMap(o => o?.split(/\s+\/\s+/) ?? []).filter(Boolean)
      const item = {
        kind: readKind(kind),
        label: label ?? null,
        ask,
        options,
        rec: recommendedOption(options, rec ?? null),
        helps: [],
      }
      added.push(item)
      newLines.push(item)
    } else if (key === 'TODO' && value && !isTakenUp(value, source)) {
      todos.push(value)
    } else if (key === 'UPDATE') {
      const [target, options, rec] = value.split('|').map(dash)
      const id = target?.match(/\b(i\d+)\b/)?.[1]
      if (id)
        updated.push({ id, options: options ? options.split(/\s+\/\s+/).filter(Boolean) : null, rec: rec ?? null })
    } else if (key === 'HELP') {
      const [target, kind, ...tail] = value.split('|')
      const { help, name } = helpFields(tail, source)
      const parsed = readHelp((kind ?? '').trim(), help, name, blocks, source)
      if (parsed && target) helps.push({ target: target.trim(), help: parsed })
    }
  }
  // HELP lines name their item, and may come before or after its NEW line.
  for (const { target, help } of helps) {
    // Lenient about extra words: the model sometimes writes "open i9" for "i9".
    const n = target.match(/\bnew\s*(\d+)\b/i)
    const id = target.match(/\b(i\d+)\b/)?.[1]
    const item = n ? newLines[Number(n[1]) - 1] : undefined
    if (item) item.helps = withHelp(item.helps, help)
    else if (!n && id) helped.push({ id, help })
  }
  const asked: Update['asked'] = []
  for (const { id, target } of asks) {
    const n = target.match(/\bnew\s*(\d+)\b/i)
    const item = n ? added.indexOf(newLines[Number(n[1]) - 1]!) : target.match(/\b(i\d+)\b/)?.[1]
    if (item !== undefined && item !== -1) asked.push({ id, item })
  }

  return seen === 0
    ? null
    : { card: { ...card, done: card.done.slice(-4) }, closed, added, helped, updated, asked, todos }
}

/**
 * Whether the reply already names most of a todo's key words, as "Added --verbose" does for "add a --verbose flag".
 * The model writes TODO lines for work the reply just did.
 */
function isTakenUp(work: string, reply: string | null): boolean {
  const key = [...keyWords(work)]
  const said = new Set(words(reply ?? ''))

  return key.length > 0 && key.filter(w => said.has(w)).length * 2 >= key.length
}

/** The question a todo the person set aside becomes. */
export function todoAsk(work: string): string {
  return `Ready to start on ${work.replace(/[.?!\s]+$/, '')}?`
}

const FILLER = new Set([
  'the',
  'and',
  'for',
  'with',
  'use',
  'into',
  'from',
  'that',
  'this',
  'your',
  'you',
  'should',
  'make',
  'add',
  'all',
])

/** The words that carry an ask's meaning. Numbers stay whatever their length, since "PR #41" is not "PR #42". */
function keyWords(text: string): Set<string> {
  return new Set(words(text).filter(w => /\p{N}/u.test(w) || (w.length > 2 && !FILLER.has(w))))
}

/**
 * Whether one ask rewords the other: most of the shorter one's key words
 * appear in the longer. Asks with one key word only match exactly, since
 * "Deploy?" and "Deploy now?" can be different questions.
 */
function restates(a: string, b: string): boolean {
  const x = keyWords(a)
  const y = keyWords(b)
  const fewer = Math.min(x.size, y.size)
  const shared = [...x].filter(w => y.has(w)).length
  const numbers = (words: Set<string>) =>
    [...words]
      .filter(w => /\p{N}/u.test(w))
      .sort()
      .join(' ')
  // Asks that name different numbers, such as two PRs, are different questions however alike their words.
  if (numbers(x) !== '' && numbers(y) !== '' && numbers(x) !== numbers(y)) return false

  return fewer >= 2 ? shared / fewer >= 0.7 : sameAsk(a, b)
}

function sameAsk(a: string, b: string): boolean {
  const norm = (s: string) => words(s).join(' ')

  return norm(a) !== '' && norm(a) === norm(b)
}

/**
 * The open item a NEW line repeats, if any. The summary model often restates
 * an open item, labelled with its id or reworded, instead of leaving it alone.
 */
function matchOpen(items: Pick<Item, 'id' | 'kind' | 'ask'>[], a: Update['added'][number]): number {
  return items.findIndex(
    i => i.id === a.label || sameAsk(i.ask, a.ask) || (i.kind === a.kind && restates(i.ask, a.ask)),
  )
}

/** Whether a NEW line repeats an item that closed at or after `since`, by matchOpen's rule or its label. */
function repeatsRecentlyClosed(closed: Closed[], a: Update['added'][number], since: number): boolean {
  const recent = closed.filter(c => c.at >= since)

  return matchOpen(recent, a) >= 0 || (a.label !== null && recent.some(c => c.label === a.label))
}

function closedRecord(item: Item, closing: Closing, now: number): Closed {
  const { id, kind, ask, label } = item

  return { id, kind, ask, ...(label ? { label } : {}), ...closing, at: now, item }
}

function closedFindingRecord(finding: Finding, closing: Closing, now: number): ClosedFinding {
  return { ...finding, ...closing, closedAt: now }
}

/** How an outcome the mod saved before `how` existed marks an item Claude closed. */
const CLOSED_BY_CLAUDE = 'closed by Claude'

/**
 * Closes an open item or finding for the agent: one the user answered in their
 * own message, with that answer as its outcome, or one that is done or no
 * longer applies, with the agent's reason. A finding moves to
 * `closedFindings` the same way. `closed` is null when no open one has the id.
 * Its `how` is the stored value 'claude' for either agent.
 */
export function closeByAgent(
  host: Host,
  ledger: Ledger,
  id: string,
  how: { answer: string } | { reason: string },
  now: number,
): { ledger: Ledger; closed: 'item' | 'finding' | null } {
  const closing: Closing =
    'answer' in how
      ? { how: 'answered', outcome: how.answer }
      : { how: 'claude', outcome: `closed by ${host.agent}: ${how.reason}` }
  if (ledger.items.some(i => i.id === id)) return { ledger: closeItem(ledger, id, closing, now), closed: 'item' }
  if (ledger.findings.some(f => f.id === id))
    return { ledger: closeFinding(ledger, id, closing, now), closed: 'finding' }

  return { ledger, closed: null }
}

/** How an item is closing: what the pane shows, and how it closed. */
export type Closing = Pick<Closed, 'how' | 'outcome'>

/** Closes one item, recording how it closed. */
export function closeItem(ledger: Ledger, id: string, closing: Closing, now: number): Ledger {
  return {
    ...ledger,
    items: ledger.items.filter(i => i.id !== id),
    closed: [...ledger.closed, ...ledger.items.filter(i => i.id === id).map(i => closedRecord(i, closing, now))].slice(
      -MAX_CLOSED,
    ),
  }
}

/** Closes one finding, recording how it closed. */
export function closeFinding(ledger: Ledger, id: string, closing: Closing, now: number): Ledger {
  const finding = ledger.findings.find(f => f.id === id)
  if (!finding) return ledger

  return {
    ...ledger,
    findings: ledger.findings.filter(f => f.id !== id),
    closedFindings: [...ledger.closedFindings, closedFindingRecord(finding, closing, now)].slice(-MAX_CLOSED),
  }
}

/** The number in an id, as 10 in "i10"; NaN for an id with none. */
function idNumber(id: string): number {
  return Number(id.match(/\d+/)?.[0] ?? Number.NaN)
}

/**
 * Puts an entry back among open ones by its id's number, so "i2" goes before
 * "i10". Order matters: answerNote reads the batch by position, and expiry
 * keeps the last MAX_OPEN items.
 */
function inIdOrder<T extends { id: string }>(open: T[], entry: T): T[] {
  const at = open.findIndex(x => idNumber(x.id) > idNumber(entry.id))

  return at < 0 ? [...open, entry] : [...open.slice(0, at), entry, ...open.slice(at)]
}

/**
 * Reopens a closed item from the item its close record kept, and removes the
 * record. Unchanged when the item is open, or no record of it kept the item.
 */
export function reopenItem(ledger: Ledger, id: string): Ledger {
  const item = ledger.closed.findLast(c => c.id === id)?.item
  if (!item || ledger.items.some(i => i.id === id)) return ledger

  return { ...ledger, items: inIdOrder(ledger.items, item), closed: ledger.closed.filter(c => c.id !== id) }
}

/** Reopens a closed finding and removes its close record. Unchanged when it is open or has no record. */
export function reopenFinding(ledger: Ledger, id: string): Ledger {
  const record = ledger.closedFindings.findLast(f => f.id === id)
  if (!record || ledger.findings.some(f => f.id === id)) return ledger
  const { how: _how, outcome: _outcome, closedAt: _closedAt, ...finding } = record

  return {
    ...ledger,
    findings: inIdOrder(ledger.findings, finding),
    closedFindings: ledger.closedFindings.filter(f => f.id !== id),
  }
}

/**
 * `promptAt` is when the update's prompt was built. A NEW line that repeats an
 * item closed since then is dropped: the person answered it while the model ran.
 */
export function applyUpdate(ledger: Ledger, u: Update, now: number, turn: number, promptAt = now): Ledger {
  const prev = ledger.card
  const card: Card = {
    goal: u.card.goal || prev?.goal || '',
    done: u.card.done.length > 0 ? u.card.done : (prev?.done ?? []),
    now: u.card.now || prev?.now || '',
    running: u.card.running,
  }
  // An UPDATE says its question still waits, so it outweighs a CLOSED line for the same question.
  const stillAsked = new Set(u.updated.filter(c => c.options || c.rec).map(c => c.id))
  const closing = new Map(u.closed.filter(c => !stillAsked.has(c.id)).map(c => [c.id, c.outcome]))
  const closed = [...ledger.closed]
  const items: Item[] = []
  for (const item of ledger.items) {
    const outcome = closing.get(item.id)
    const helps = u.helped.filter(h => h.id === item.id).reduce((all, h) => withHelp(all, h.help), item.helps)
    if (outcome === undefined) items.push(withUpdate({ ...item, helps }, u.updated))
    else closed.push(closedRecord(item, { outcome, how: 'update' }, now))
  }

  let nextId = ledger.nextId
  let added = 0
  // The open item each NEW line became, by its place in u.added; null for one dropped as recently closed.
  const addedIds: (string | null)[] = []
  const created = new Set<string>()
  for (const a of u.added) {
    if (repeatsRecentlyClosed(ledger.closed, a, promptAt)) {
      addedIds.push(null)
      continue
    }
    const at = matchOpen(items, a)
    const restated = items[at]
    if (restated) {
      items[at] = { ...restated, helps: a.helps.reduce((all, h) => withHelp(all, h), restated.helps) }
      addedIds.push(restated.id)
      continue
    }
    items.push({ ...a, id: `i${nextId}`, turn, at: now })
    addedIds.push(`i${nextId}`)
    created.add(`i${nextId}`)
    nextId += 1
    added += 1
  }
  // Every todo asks the same question, built here. The model sometimes reads work the person puts off as a todo,
  // so a todo that rewords an open item or finding, or one closed while the model ran, adds nothing.
  for (const work of u.todos) {
    const todo = {
      kind: 'question' as const,
      label: null,
      ask: todoAsk(work),
      options: ['Proceed', 'Not yet'],
      rec: null,
    }
    const isKnown =
      items.some(i => restates(i.ask, work)) ||
      ledger.findings.some(f => restates(f.title, work)) ||
      repeatsRecentlyClosed(ledger.closed, { ...todo, helps: [] }, promptAt)
    if (isKnown) continue
    items.push({ ...todo, helps: [], id: `i${nextId}`, turn, at: now })
    nextId += 1
    added += 1
  }

  // An item left unanswered too long, or pushed out by newer ones, closes as expired.
  const kept = items.filter(i => turn - i.turn <= STALE_AFTER).slice(-MAX_OPEN)
  for (const i of items) if (!kept.includes(i)) closed.push(closedRecord(i, { outcome: EXPIRED, how: 'expired' }, now))

  // A finding an open item asks about closes into that item, so one thing shows in one list. The model names
  // the pairs in ASKED lines; a new item that rewords a finding's title closes it without one.
  const askedBy = new Map<string, string>()
  for (const a of u.asked) {
    const id = typeof a.item === 'number' ? addedIds[a.item] : a.item
    if (id && kept.some(i => i.id === id)) askedBy.set(a.id, id)
  }
  for (const i of kept.filter(i => created.has(i.id)))
    for (const f of ledger.findings) if (!askedBy.has(f.id) && restates(f.title, i.ask)) askedBy.set(f.id, i.id)
  const { findings, closedFindings } = ledger.findings.reduce((l, f) => {
    const asker = askedBy.get(f.id)
    const outcome = closing.get(f.id) ?? (asker ? `asked as ${asker}` : undefined)

    return outcome === undefined ? l : closeFinding(l, f.id, { outcome, how: 'update' }, now)
  }, ledger)

  return {
    ...ledger,
    card,
    items: kept,
    closed: closed.slice(-MAX_CLOSED),
    findings,
    closedFindings,
    nextId,
    batchTurn: added > 0 ? turn : ledger.batchTurn,
  }
}

/**
 * A question with the options and recommendation an UPDATE line gives it. A recommendation is kept only while it
 * is one of the options, so new options without a new recommendation drop one that no longer fits.
 */
function withUpdate(item: Item, updated: Update['updated']): Item {
  const change = updated.findLast(c => c.id === item.id)
  if (!change || item.kind !== 'question') return item
  const options = change.options ?? item.options

  return { ...item, options, rec: recommendedOption(options, change.rec ?? item.rec) }
}

/** The items the agent's latest reply added, which "1. yes" answers refer to. */
export function latestBatch(ledger: Ledger): Item[] {
  return ledger.batchTurn === 0 ? [] : ledger.items.filter(i => i.turn === ledger.batchTurn)
}

function describe(item: Item): string {
  const parts = [`"${item.ask}"`]
  if (item.options.length > 0) parts.push(`options: ${item.options.join(' / ')}`)
  if (item.rec) parts.push(`recommended: ${item.rec}`)
  if (item.kind === 'task') parts.push('an action for the user')

  return parts.join('; ')
}

// The numbers LINE_ANSWER reads, so a label's number is one a typed answer can reach. Digits inside an id,
// as in a label naming finding f235, are not one.
function numberOf(label: string | null): number | null {
  const m = label?.match(/(?:^|[^A-Za-z\d])(?:[QqDd#]\s?)?(\d{1,2})(?!\d)/)

  return m ? Number(m[1]) : null
}

/**
 * The latest batch, when the reply that added it came just before the prompt
 * numbered `promptTurn`; otherwise empty, since "1. yes" no longer refers to it.
 */
function answerableBatch(ledger: Ledger, promptTurn: number): Item[] {
  return ledger.batchTurn === promptTurn - 1 ? latestBatch(ledger) : []
}

/**
 * The item each number in "1. yes" answers. When any item in the batch has a
 * number in its label, numbers come from labels, unlabeled items get none, and
 * the first item with a number keeps it. Otherwise each item's number is its
 * place in the batch, tasks included.
 */
function batchNumbers(batch: Item[]): Map<number, Item> {
  const hasLabels = batch.some(i => numberOf(i.label) !== null)
  const byNumber = new Map<number, Item>()
  batch.forEach((item, at) => {
    const n = hasLabels ? numberOf(item.label) : at + 1
    if (n !== null && !byNumber.has(n)) byNumber.set(n, item)
  })

  return byNumber
}

/**
 * The number a person can answer each question of the latest batch by, in
 * the prompt numbered `promptTurn`, by the rule answerNote reads answers with.
 * Tasks are numbered too, but only questions are returned.
 */
export function questionNumbers(ledger: Ledger, promptTurn: number): Map<string, number> {
  const numbers = new Map<string, number>()
  for (const [n, item] of batchNumbers(answerableBatch(ledger, promptTurn)))
    if (item.kind === 'question') numbers.set(item.id, n)

  return numbers
}

const LINE_ANSWER = /(?:^|\n)\s*(?:[QqDd#]\s?)?(\d{1,2})\s*[.):\-–]\s*\S/g
const INLINE_ANSWER = /\s(?:[QqDd#]\s?)?(\d{1,2})\s*[.)]\s+\S/g
// A blanket go-ahead, in English or Polish.
const ACCEPT_ALL =
  /^\s*(go|go ahead|yes|yep|yeah|sure|ok|okay|sgtm|lgtm|sounds good|do it|proceed|all good|ship it|tak|okej|dawaj|jasne|zgoda|rób|rób to|działaj|lecimy|śmiało|pasuje|może być)\s*[.!]*\s*$/i
const ACCEPT_RECS =
  /\b(all|both|everything|your)\b[^.\n]{0,40}\b(recommend\w*|recs?|suggest\w*|picks?|calls?)\b|\b(wszystk\w*|obie|obydwie|twoj\w*)\b[^.\n]{0,40}\b(rekomend|propozycj|propon|sugest|sugeruj)|\b(jak|zgodnie z)\b[^.\n]{0,20}\b(rekomend|propozycj|propon|sugest|sugeruj)/i

/**
 * The note attached to the person's prompt when it answers open items:
 * numbered answers mapped to the latest batch, an item quoted from the band,
 * or a blanket "go" over the latest recommendations. Null when it answers none.
 *
 * `ledger.turn` already counts this prompt, so the latest batch is only
 * offered when it came from the reply just before it.
 */
export function answerNote(ledger: Ledger, text: string): string | null {
  const lines: string[] = []
  const batch = answerableBatch(ledger, ledger.turn)

  if (batch.length > 0) {
    const numbers = new Set<number>()
    for (const m of text.matchAll(LINE_ANSWER)) numbers.add(Number(m[1]))
    // "1. node 2. yes" on one line counts only when the message opens with an
    // answer, so "bullet 4." mid-sentence is not read as answering item 4.
    if (/^\s*(?:[QqDd#]\s?)?\d{1,2}\s*[.):\-–]\s/.test(text)) {
      for (const m of text.matchAll(INLINE_ANSWER)) numbers.add(Number(m[1]))
    }
    const byNumber = batchNumbers(batch)
    for (const n of [...numbers].sort((a, b) => a - b)) {
      const item = byNumber.get(n)
      if (item) lines.push(`- ${n} → ${describe(item)}`)
    }
    if (lines.length === 0 && (ACCEPT_ALL.test(text) || ACCEPT_RECS.test(text))) {
      const withRecs = batch.filter(i => i.rec)
      if (withRecs.length > 0) {
        return [
          'inbox: if the user is accepting your recommendations, these are the open ones:',
          ...withRecs.map(i => `- ${i.label ?? '•'} → ${describe(i)}`),
        ].join(NL)
      }
    }
  }

  return lines.length === 0
    ? null
    : ["inbox: the user's message answers these open items from your earlier replies:", ...lines].join(NL)
}

/**
 * Adds a finding Claude recorded. One whose title matches an open finding, or
 * rewords an open item's ask, is skipped, so one thing shows in one list. When
 * the list is full, the oldest finding closes as expired to make room.
 */
export function addFinding(
  ledger: Ledger,
  finding: Omit<Finding, 'id'>,
): { ledger: Ledger; id: string; isAdded: boolean; expired: Finding | null } {
  const same =
    ledger.findings.find(f => sameAsk(f.title, finding.title)) ?? ledger.items.find(i => restates(i.ask, finding.title))
  if (same) return { ledger, id: same.id, isAdded: false, expired: null }
  const id = `f${ledger.nextId}`
  const expired = ledger.findings.length >= MAX_FINDINGS ? ledger.findings[0]! : null
  const room = expired ? closeFinding(ledger, expired.id, { how: 'expired', outcome: 'list full' }, finding.at) : ledger

  return {
    ledger: { ...room, findings: [...room.findings, { ...finding, id }], nextId: ledger.nextId + 1 },
    id,
    isAdded: true,
    expired,
  }
}

/** An open item as Claude reads it, with its id when Claude may close it. */
function itemLine(item: Item, withId: boolean): string {
  return `- ${withId ? `[${item.id}] ` : ''}${item.label ? `(${item.label}) ` : ''}${describe(item)}`
}

function findingLine(finding: Finding, withId: boolean): string {
  return `- ${withId ? `[${finding.id}] ` : ''}${finding.kind}: ${finding.title}`
}

/**
 * What the model reads after a compaction, so open items and the goal
 * survive it. Ids go in only for this session's own ledger, since Claude
 * closes items by id; the previous session's items are not this one's.
 */
export function carryText(ledger: Ledger, title: string, isOwn = false): string | null {
  const findings = ledger.findings
  if (!ledger.card && ledger.items.length === 0 && findings.length === 0) return null
  const out = [title]
  if (ledger.card) {
    if (ledger.card.goal) out.push(`Goal: ${ledger.card.goal}`)
    if (ledger.card.done.length > 0) out.push(`Done: ${ledger.card.done.join('; ')}`)
    if (ledger.card.now) out.push(`Now: ${ledger.card.now}`)
    if (ledger.card.running.length > 0) out.push(`Running: ${ledger.card.running.join('; ')}`)
  }
  if (ledger.items.length > 0) {
    out.push('Waiting on the user:')
    for (const item of ledger.items) out.push(itemLine(item, isOwn))
  }
  if (findings.length > 0) {
    out.push(isOwn ? 'Findings you recorded, still open:' : 'Findings that session recorded, still open:')
    for (const f of findings) out.push(findingLine(f, isOwn))
  }
  if (ledger.closed.length > 0) {
    out.push('Recently closed:')
    for (const d of ledger.closed.slice(-6)) out.push(`- "${d.ask}" → ${outcomeText(d)}`)
  }

  return out.join(NL)
}

/**
 * The inbox as the agent reads it beside a prompt: what is open now and whether
 * the host's surface shows it. prompt.context reaches only the first message,
 * so this is how the agent learns what changed since.
 */
export function inboxText(host: Host, ledger: Ledger, isOpen: boolean): string {
  const out = ['inbox: what waits on the user, as of your last reply. Anything not listed here is closed.']
  if (ledger.items.length > 0) {
    out.push('Waiting on the user:')
    for (const item of ledger.items) out.push(itemLine(item, true))
  } else {
    out.push('Nothing is waiting on the user.')
  }
  if (ledger.findings.length > 0) {
    out.push('Findings you recorded, still open:')
    for (const f of ledger.findings) out.push(findingLine(f, true))
  }
  out.push(isOpen ? `The user has ${host.surface} open beside the conversation.` : `${surfaceAtStart(host)} is closed.`)

  return out.join(NL)
}

/** How an item or finding ended: handled, set aside by the person, or overtaken without anyone deciding it. */
export type ClosedState = 'handled' | 'dismissed' | 'lapsed'

export function closedState(d: Pick<Closed, 'how' | 'outcome'>): ClosedState {
  if (d.how === 'dismissed') return 'dismissed'
  if (d.how === 'expired') return 'lapsed'
  // The agent's close and the per-reply update write their own outcome, so only its wording says the work
  // overtook the item. An agent's close reads "closed by <agent>: <reason>".
  const isOvertaken = /^(?:closed by \w+: )?(?:no longer applies|replaced|superseded|moot)/i.test(d.outcome)

  return (d.how === 'claude' || d.how === 'update') && isOvertaken ? 'lapsed' : 'handled'
}

/** An item that closed without being handled: dismissed, expired, or overtaken by the work. */
export function isLapsed(d: Pick<Closed, 'how' | 'outcome'>): boolean {
  return closedState(d) !== 'handled'
}

/** How an item closed, in words a model reads without the mod's vocabulary. */
function outcomeText(d: Closed): string {
  if (d.how === 'dismissed') return 'dismissed by the user'
  if (d.how === 'expired') return 'expired before the user answered'

  return d.outcome
}

/**
 * The items closed since Claude last read the inbox, so Claude can tell a
 * dismissed question from one still waiting, and an expired one from one answered.
 */
export function closedText(closed: Closed[]): string | null {
  if (closed.length === 0) return null
  const advice = (d: Closed) =>
    d.how === 'dismissed'
      ? '. Ask it again only if the user brings it up.'
      : d.how === 'expired'
        ? '. Ask it again if it still matters.'
        : ''

  return [
    'Closed since you last read the inbox:',
    ...closed.map(d => `- "${d.ask}" → ${outcomeText(d)}${advice(d)}`),
  ].join(NL)
}

/** The inbox text the agent last read beside a prompt, and the closed items it was told about, by id. */
export type Told = { inbox: string | null; closed: string[] }

export const TOLD_NOTHING: Told = { inbox: null, closed: [] }

/**
 * What the agent reads beside a prompt: whether it answers an open item,
 * unless a press sent it, and the inbox when it changed since the agent last
 * read it or when an item closed since. An empty inbox with nothing closed
 * says nothing new. Also returns what the agent has now been told.
 */
export function promptNotes(
  host: Host,
  ledger: Ledger,
  prompt: { text: string; isPress: boolean; isOpen: boolean },
  told: Told,
): { notes: string[]; told: Told } {
  const notes: string[] = []
  // A press's message already says what it does; an Explain, for one, quotes its item without answering it.
  const answer = prompt.isPress ? null : answerNote(ledger, prompt.text)
  if (answer) notes.push(answer)
  const inbox = inboxText(host, ledger, prompt.isOpen)
  const toldClosed = new Set(told.closed)
  const closed = closedText(ledger.closed.filter(d => !toldClosed.has(d.id)))
  const isEmpty = ledger.items.length === 0 && ledger.findings.length === 0
  if (!closed && (inbox === told.inbox || (isEmpty && told.inbox === null))) return { notes, told }
  notes.push(closed ? `${inbox}${NL}${closed}` : inbox)

  return { notes, told: { inbox, closed: ledger.closed.map(d => d.id) } }
}

/**
 * The stop's kind, from the error word and the message Claude Code showed.
 * A reached usage limit and a busy server are both `rate_limit`; only the
 * message, "You've hit your weekly limit · resets 7:33pm", tells them apart.
 */
export function stopKindOf(error: string, message: string): Stop['kind'] {
  if (error === 'rate_limit') return /\bhit your\b.*\blimit\b/i.test(message) ? 'usage-limit' : 'api-error'
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'verification_required':
    case 'cloud_credential_error':
      return 'sign-in'
    case 'billing_error':
    case 'account_on_hold':
      return 'billing'
    default:
      return 'api-error'
  }
}

/** When a usage limit resets, as Claude Code's message says it: "7:33pm". */
export function resetTime(message: string): string | null {
  return message.match(/\bresets\s+(?:at\s+)?([^·(\n]+?)\s*(?:\(|·|$)/i)?.[1]?.trim() ?? null
}

/** "sign-in expired" */
export function stopText(stop: Stop): string {
  switch (stop.kind) {
    case 'sign-in':
      return 'sign-in expired'
    case 'billing':
      return 'billing problem'
    case 'usage-limit':
      return 'usage limit reached'
    default:
      return stop.detail === 'rate_limit'
        ? 'the API is limiting requests'
        : stop.detail === 'overloaded'
          ? 'the API is overloaded'
          : `API error (${stop.detail})`
  }
}

/** What the person does to clear a stop. */
export function stopFix(stop: Stop): string {
  switch (stop.kind) {
    case 'sign-in':
      return 'Run /login, then send a message to resume.'
    case 'billing':
      return 'Check billing in the Claude console, then resume.'
    case 'usage-limit':
      return stop.resets ? `Resume after ${stop.resets}.` : 'Resume when the limit resets.'
    default:
      return 'Send a message to resume.'
  }
}

/** The stop and its fix in a few words, for the sidebar. */
function stopShort(stop: Stop): string {
  switch (stop.kind) {
    case 'sign-in':
      return 'Signed out: /login'
    case 'billing':
      return 'Billing problem'
    case 'usage-limit':
      return stop.resets ? `Limit: resets ${stop.resets}` : 'Usage limit reached'
    default:
      return 'API error: resume'
  }
}

/** "Allow push main to origin?", or a question dialog's question. */
function dialogText(dialog: Dialog): string {
  return dialog.kind === 'permission' ? `Allow ${dialog.text}?` : dialog.text
}

/**
 * The session's line in the Herdr sidebar: a stop and its fix, else an open
 * dialog, else how many items wait and the first of `ledger.items`, else
 * where the work stands. The caller passes the items in the order Needs you
 * lists them, so the line names the pane's top row. The count leads, because
 * the sidebar cuts long lines at its edge. Empty when there is nothing to say.
 */
export function statusLine(ledger: Ledger, stop: Stop | null, dialogs: Dialog[]): string {
  if (stop) return `! ${stopShort(stop)}`
  const dialog = dialogs[0]
  if (dialog) return dialogText(dialog)
  const first = ledger.items[0]
  if (first) return ledger.items.length > 1 ? `${ledger.items.length} · ${first.ask}` : first.ask
  const count = ledger.findings.length
  const findings = count === 0 ? null : `${count} finding${count === 1 ? '' : 's'}`

  return [ledger.card?.now, findings].filter(Boolean).join(' · ')
}

/** "just now", "12m ago", "3h ago", "2d ago". */
export function ago(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h}h ago`

  return `${Math.round(h / 24)}d ago`
}
