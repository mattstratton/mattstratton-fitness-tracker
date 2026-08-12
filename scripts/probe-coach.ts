/**
 * Run the trap probes against the real /ask machinery and print what each turn
 * actually cost.
 *
 * Exists for the same reason scripts/verify-signal-history.ts does: the cache,
 * cost and latency figures quoted about this chat came from reading a server
 * log once, by hand, and were then repeated for weeks with nothing to check
 * them against. One of the other numbers gathered that way turned out to be
 * wrong (see that script), so these get to be re-runnable too.
 *
 * Deliberately calls the same toolRunner config as app/api/coach/route.ts
 * rather than a simplified version -- a probe that measures something adjacent
 * to production tells you about the probe.
 *
 * MAKES REAL, BILLED API CALLS. Roughly a handful of cents per run.
 *
 *   npm run probe-coach            # all probes
 *   npm run probe-coach -- 3       # just probe 3
 */
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'

import { buildRuntimeContext, buildSystemPrompt } from '../lib/coach/prompt.js'
import { COACH_TOOLS } from '../lib/coach/tools.js'
import { getPool, loadEnv } from '../lib/db.js'
import {
  loadExerciseTarget,
  loadFreshness,
  loadTargets,
  loadTodayDate,
} from '../lib/queries.js'

// Kept in sync with app/api/coach/route.ts by hand. If these drift, the numbers
// this prints stop describing production.
const MODEL = 'claude-opus-5'
const EFFORT = 'medium' as const
const MAX_ITERATIONS = 8

/** Opus 5 list rates, USD per million tokens. Update if pricing moves. */
const PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }

/**
 * The traps each probe is aimed at. Every one of these has produced a wrong
 * answer in this project at least once, which is why they are the probes.
 */
const PROBES = [
  'how many calories have I eaten today?',
  "what's my average protein over the last week?",
  'am I stalling on squat?',
  'how big is my deficit actually?',
  'how much have I been training lately?',
  "what's my weight doing?",
  'how has my sleep been?',
  "what's my vo2 max doing?",
  'did I miss any sets recently?',
]

type TurnUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function costUsd(u: TurnUsage): number {
  return (
    (u.input * PRICE.input +
      u.output * PRICE.output +
      u.cacheWrite * PRICE.cacheWrite +
      u.cacheRead * PRICE.cacheRead) /
    1_000_000
  )
}

async function main() {
  // Same .env handling getPool() does, but the key is needed before any query.
  loadEnv()
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (it lives in .env)')

  const only = process.argv[2] ? Number(process.argv[2]) : null
  const probes = only ? [PROBES[only - 1]!] : PROBES

  const [today, targets, exerciseTarget, freshness] = await Promise.all([
    loadTodayDate(),
    loadTargets(),
    loadExerciseTarget(),
    loadFreshness(),
  ])
  const runtimeContext = buildRuntimeContext({
    today,
    targets,
    exerciseMinutesTarget: exerciseTarget.minutesTarget,
    freshness,
  })

  const client = new Anthropic({ apiKey })
  const results: {
    q: string
    turns: number
    tools: string[]
    usage: TurnUsage
    ms: number
    ttftMs: number | null
    answer: string
  }[] = []

  for (const [i, q] of probes.entries()) {
    const messages: BetaMessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: runtimeContext },
          { type: 'text', text: q },
        ],
      },
    ]

    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: EFFORT },
      system: [
        { type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } },
      ],
      tools: COACH_TOOLS,
      messages,
      max_iterations: MAX_ITERATIONS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      stream: true,
    })

    const started = Date.now()
    let ttftMs: number | null = null
    const usage: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const tools: string[] = []
    let turns = 0
    let answer = ''

    for await (const stream of runner) {
      turns++
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          tools.push(event.content_block.name)
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          if (ttftMs === null) ttftMs = Date.now() - started
          answer += event.delta.text
        }
      }
      const m = await stream.finalMessage()
      usage.input += m.usage.input_tokens
      usage.output += m.usage.output_tokens
      usage.cacheRead += m.usage.cache_read_input_tokens ?? 0
      usage.cacheWrite += m.usage.cache_creation_input_tokens ?? 0
    }

    const ms = Date.now() - started
    results.push({ q, turns, tools, usage, ms, ttftMs, answer: answer.trim() })
    console.log(
      `[${i + 1}/${probes.length}] ${(ms / 1000).toFixed(1)}s  ${turns} turn(s)  ` +
        `tools=${tools.join(',') || 'none'}  $${costUsd(usage).toFixed(4)}   ${q}`,
    )
  }

  console.log('\n--- per probe ---')
  console.log('  #  secs  ttft  turns  in     out    cacheR  cacheW  cost')
  for (const [i, r] of results.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}  ` +
        `${(r.ms / 1000).toFixed(1).padStart(4)}  ` +
        `${(r.ttftMs === null ? '-' : (r.ttftMs / 1000).toFixed(1)).padStart(4)}  ` +
        `${String(r.turns).padStart(5)}  ` +
        `${String(r.usage.input).padStart(5)}  ${String(r.usage.output).padStart(5)}  ` +
        `${String(r.usage.cacheRead).padStart(6)}  ${String(r.usage.cacheWrite).padStart(6)}  ` +
        `$${costUsd(r.usage).toFixed(4)}`,
    )
  }

  const secs = results.map((r) => r.ms / 1000)
  const costs = results.map((r) => costUsd(r.usage))
  const reads = results.map((r) => r.usage.cacheRead).filter((n) => n > 0)
  console.log('\n--- totals ---')
  console.log(`  probes:       ${results.length}`)
  console.log(`  latency:      ${Math.min(...secs).toFixed(1)}s .. ${Math.max(...secs).toFixed(1)}s`)
  console.log(
    `  cost/probe:   $${Math.min(...costs).toFixed(4)} .. $${Math.max(...costs).toFixed(4)}` +
      `  (total $${costs.reduce((a, b) => a + b, 0).toFixed(3)})`,
  )
  console.log(
    `  cacheRead:    ${reads.length ? `${Math.min(...reads)} .. ${Math.max(...reads)}` : 'never served from cache'}` +
      `  across ${reads.length}/${results.length} probes`,
  )

  console.log('\n--- answers (read these; the numbers above cannot tell you if it was right) ---')
  for (const [i, r] of results.entries()) {
    console.log(`\n[${i + 1}] ${r.q}\n${r.answer}`)
  }

  await getPool().end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
