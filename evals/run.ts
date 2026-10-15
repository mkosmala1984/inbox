// Runs the inbox model on the cases in cases.json and checks the ledger each answer leaves. The model's answers
// vary from run to run, so each case runs several times and passes when enough runs pass its checks.
//
// Usage: ./scripts/eval.sh [--runs N] [--case name,name] [--out answers.json]
// scripts/eval.sh bundles this file and passes --cases, the path of cases.json.

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { applyUpdate, buildPrompt, CLAUDE_CODE, EMPTY, parseReply, systemText } from '../hooks/ledger'
import type { Exchange } from '../hooks/ledger'
import type { Ledger } from '../types'

/** One check on the ledger after the update. Patterns are case-insensitive regular expressions. */
type Check =
  | { open: string }
  | { closed: string; outcome?: string }
  | { added: number }
  | { new: string; kind?: 'question' | 'task'; rec?: string | null; help?: string }
  | { notNew: string }
  | { noHelp: string }
  | { item: string; rec?: string; options?: string }
  | { waiting: string; options?: string }

type Case = {
  name: string
  about: string
  ledger: Partial<Ledger>
  exchange: Partial<Exchange> & { reply: string }
  checks: Check[]
  /** The share of runs that must pass, when it differs from MIN. */
  min?: number
}

const MIN = 0.75
const NOW = 100

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '4' },
    case: { type: 'string' },
    out: { type: 'string' },
    cases: { type: 'string', default: 'evals/cases.json' },
  },
})
const runs = Number(values.runs)
const wanted = values.case ? new Set(values.case.split(',')) : null
const cases: Case[] = JSON.parse(readFileSync(values.cases, 'utf8')).filter((c: Case) => !wanted || wanted.has(c.name))

function claude(prompt: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile(
      'claude',
      ['-p', '--model', 'sonnet', '--tools', '', '--system-prompt', systemText(CLAUDE_CODE)],
      { maxBuffer: 1 << 22, timeout: 300_000 },
      (err, out) => resolve(err ? null : out),
    )
    child.stdin?.end(prompt)
  })
}

/** The checks the ledger fails, each as a short reason; empty when all pass. */
function failures(before: Ledger, after: Ledger, checks: Check[]): string[] {
  const has = (pattern: string, text: string | null) => text !== null && new RegExp(pattern, 'i').test(text)
  const added = after.items.filter(i => !before.items.some(b => b.id === i.id))
  const isOpen = (id: string) => after.items.some(i => i.id === id) || after.findings.some(f => f.id === id)
  const closedOutcome = (id: string) =>
    after.closed.find(c => c.id === id)?.outcome ?? after.closedFindings.find(f => f.id === id)?.outcome ?? null
  const out: string[] = []
  for (const c of checks) {
    if ('open' in c && !isOpen(c.open)) out.push(`${c.open} closed`)
    else if ('closed' in c) {
      const outcome = closedOutcome(c.closed)
      if (outcome === null) out.push(`${c.closed} still open`)
      else if (c.outcome && !has(c.outcome, outcome)) out.push(`${c.closed} closed as "${outcome}"`)
    } else if ('added' in c && added.length !== c.added) out.push(`${added.length} items added`)
    else if ('new' in c) {
      const match = added.find(
        i =>
          has(c.new, i.ask) &&
          (!c.kind || i.kind === c.kind) &&
          (c.rec === undefined || (c.rec === null ? i.rec === null : has(c.rec, i.rec))) &&
          (!c.help || i.helps.some(h => h.kind === c.help)),
      )
      if (!match) out.push(`no new item like /${c.new}/: ${added.map(i => `"${i.ask}" rec=${i.rec}`).join(', ')}`)
    } else if ('notNew' in c && added.some(i => has(c.notNew, i.ask))) out.push(`added an item like /${c.notNew}/`)
    else if ('noHelp' in c && added.some(i => i.helps.some(h => h.kind === c.noHelp))) out.push(`a ${c.noHelp} step`)
    else if ('waiting' in c) {
      const match = after.items.find(
        i => has(c.waiting, i.ask) && (!c.options || has(c.options, i.options.join(' / '))),
      )
      if (!match) out.push(`no open item like /${c.waiting}/: ${after.items.map(i => `"${i.ask}"`).join(', ')}`)
    } else if ('item' in c) {
      const item = after.items.find(i => i.id === c.item)
      if (!item) out.push(`${c.item} closed`)
      else if (c.rec && !has(c.rec, item.rec)) out.push(`${c.item} rec=${item.rec}`)
      else if (c.options && !has(c.options, item.options.join(' / ')))
        out.push(`${c.item} options ${item.options.join(' / ')}`)
    }
  }

  return out
}

type Result = { name: string; run: number; answer: string | null; failed: string[] }

async function once(c: Case, n: number): Promise<Result> {
  const ledger = { ...EMPTY, ...c.ledger } as Ledger
  const ex: Exchange = {
    person: null,
    trigger: null,
    activity: [],
    turn: ledger.turn,
    press: null,
    screen: 'The /inbox pane is closed.',
    ...c.exchange,
  }
  const prompt = buildPrompt(ledger, ex)
  const answer = await claude(prompt)
  const update = answer === null ? null : parseReply(answer, `${ex.reply}\n${ex.activity.join('\n')}`)
  const failed =
    update === null
      ? ['no answer the mod can read']
      : failures(ledger, applyUpdate(ledger, update, NOW, ledger.turn), c.checks)

  return { name: c.name, run: n, answer, failed }
}

const jobs = cases.flatMap(c => Array.from({ length: runs }, (_, n) => () => once(c, n)))
const results: Result[] = []
let next = 0
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) results.push(await jobs[next++]!())
  }),
)
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1))

let isFailing = false
for (const c of cases) {
  const mine = results.filter(r => r.name === c.name)
  const passed = mine.filter(r => r.failed.length === 0).length
  const isPass = passed / mine.length >= (c.min ?? MIN)
  isFailing ||= !isPass
  console.log(`${isPass ? '  ok' : '  x '} ${c.name}: ${passed} of ${mine.length}`)
  if (!isPass) for (const r of mine) if (r.failed.length > 0) console.log(`       ${r.failed.join('; ')}`)
}
process.exit(isFailing ? 1 : 0)
