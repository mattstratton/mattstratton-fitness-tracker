// POST /api/coach -- the coaching chat's turn endpoint (#8).
//
// Streams Server-Sent Events back to /ask. The Anthropic API key is read here and
// nowhere else: it never reaches a client component, and a missing one is a hard
// failure rather than a degraded mode.
//
// SECURITY: `proxy.ts` excludes /api from the auth middleware on purpose, so this
// route is open to the internet unless it authenticates itself. It does, via
// lib/coach/guard.ts. Do not remove that call, and do not assume the middleware
// is covering this path -- it is not.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'

import { auth } from '../../../auth.js'
import { isAuthorizedApiSession } from '../../../lib/coach/guard.js'
import { buildRuntimeContext, buildSystemPrompt } from '../../../lib/coach/prompt.js'
import type { CoachEvent } from '../../../lib/coach/stream.js'
import { encodeEvent } from '../../../lib/coach/stream.js'
import { COACH_TOOLS } from '../../../lib/coach/tools.js'
import { json } from '../../../lib/http.js'
import {
  loadExerciseTarget,
  loadFreshness,
  loadTargets,
  loadTodayDate,
} from '../../../lib/queries.js'

/** A turn can involve several tool round trips; the Vercel default is 300s. */
export const maxDuration = 300

const MODEL = 'claude-opus-5'

/**
 * Effort is the first knob to reach for if answers are too shallow or too slow.
 * `medium` because this is an interactive chat on a phone and the reasoning
 * involved is "call the right tools and read them honestly" rather than anything
 * hard -- and Opus 5 is unusually strong at the lower levels. Raise to `high` if
 * multi-tool questions start getting sloppy.
 */
const EFFORT = 'medium' as const

/** Tool loops per turn. A coaching answer needs a handful; anything approaching
 *  this is a loop, not thoroughness. */
const MAX_ITERATIONS = 8

/** Turns of history accepted. This is a single-user app with no persistence, so
 *  the real purpose is bounding cost if a tab is left open for a very long time. */
const MAX_MESSAGES = 40

/** Bytes of request body accepted, as a backstop on the same. */
const MAX_BODY_BYTES = 200_000

type ClientMessage = { role: 'user' | 'assistant'; content: string }

/**
 * Validate the client's transcript.
 *
 * History is text-only by design: prior tool calls and results are NOT replayed.
 * That costs a little -- a follow-up question may re-query data the previous turn
 * already fetched -- and buys two things worth more. The transcript stays a plain
 * list of strings, so there is no way for a malformed replayed tool block to
 * wedge a conversation; and a follow-up re-reads the database rather than
 * reasoning over a snapshot from several minutes ago, which for a chat whose
 * whole job is answering from current data is the behaviour you want anyway.
 */
function parseMessages(payload: unknown): ClientMessage[] | string {
  if (typeof payload !== 'object' || payload === null) return 'body must be a JSON object'
  const raw = (payload as { messages?: unknown }).messages
  if (!Array.isArray(raw)) return 'messages must be an array'
  if (raw.length === 0) return 'messages must not be empty'
  if (raw.length > MAX_MESSAGES) return `too many messages (max ${MAX_MESSAGES})`

  const messages: ClientMessage[] = []
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) return 'each message must be an object'
    const { role, content } = m as { role?: unknown; content?: unknown }
    if (role !== 'user' && role !== 'assistant') return 'role must be user or assistant'
    if (typeof content !== 'string' || content.trim() === '') return 'content must be a non-empty string'
    messages.push({ role, content })
  }
  if (messages[0]?.role !== 'user') return 'the first message must be from the user'
  return messages
}

export async function POST(request: Request): Promise<Response> {
  // 1. Authenticate. See the note at the top of this file: nothing else does.
  const session = await auth()
  if (!isAuthorizedApiSession(session, {
    NODE_ENV: process.env['NODE_ENV'],
    DEV_BYPASS_AUTH: process.env['DEV_BYPASS_AUTH'],
  })) {
    return json({ error: 'unauthorized' }, 401)
  }

  // 2. A missing key is a misconfiguration, never "chat disabled".
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set; refusing coaching requests')
    return json({ error: 'server misconfigured' }, 500)
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413)

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return json({ error: 'body was not JSON' }, 400)
  }

  const parsed = parseMessages(payload)
  if (typeof parsed === 'string') return json({ error: parsed }, 400)

  // 3. Fetch the per-conversation facts. Cheap, and it means freshness and the
  //    current targets are in front of the model without it having to ask.
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

  // Prepended to the first user turn as its own block, so it sits AFTER the
  // cached system+tools prefix. Recomputed every turn rather than echoed back by
  // the client: if targets change at /settings or the day rolls over mid
  // conversation, the model should see the new value. That costs one uncached
  // turn on the rare occasion it changes, which is the right trade.
  const messages: BetaMessageParam[] = parsed.map((m, i) =>
    i === 0
      ? { role: 'user' as const, content: [{ type: 'text' as const, text: runtimeContext }, { type: 'text' as const, text: m.content }] }
      : { role: m.role, content: m.content },
  )

  const client = new Anthropic({ apiKey })

  const runner = client.beta.messages.toolRunner(
    {
      model: MODEL,
      max_tokens: 4096,
      // Thinking is on by default on Opus 5; `display` defaults to 'omitted',
      // which on a phone reads as a long dead pause before any output appears.
      // Summarised reasoning is streamed as a transient status line instead --
      // which also suits an app whose other verdicts are all auditable.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: EFFORT },
      // Tools render before system, so one breakpoint on the system block covers
      // the tool definitions too -- and those are the bulk of the stable prefix.
      system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      tools: COACH_TOOLS,
      messages,
      max_iterations: MAX_ITERATIONS,
      // Safety classifiers can decline a request outright. Physiology and
      // nutrition sit near enough to that territory to be worth the insurance,
      // and 'default' routes by refusal category rather than pinning a model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      stream: true,
    },
    { signal: request.signal },
  )

  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (event: CoachEvent): void => {
        if (closed) return
        controller.enqueue(encoder.encode(encodeEvent(event)))
      }

      try {
        // Outer loop: one iteration per assistant turn (each followed by tool
        // execution the runner performs itself). Inner loop: that turn's events.
        for await (const stream of runner) {
          for await (const event of stream) {
            if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
              send({ t: 'tool', name: event.content_block.name })
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') send({ t: 'text', delta: event.delta.text })
              else if (event.delta.type === 'thinking_delta') send({ t: 'thinking', delta: event.delta.thinking })
            }
          }

          const message = await stream.finalMessage()

          // Logged per assistant turn because the two numbers worth watching are
          // invisible otherwise. `cacheRead` at 0 across a conversation means
          // something volatile got into the prefix and every turn is paying full
          // price for the system prompt and tool definitions. `out` is what the
          // turn actually cost.
          const u = message.usage
          console.log(
            `coach turn: in=${u.input_tokens} out=${u.output_tokens} ` +
              `cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0} ` +
              `stop=${message.stop_reason}`,
          )

          if (message.stop_reason === 'refusal') {
            // A 200 with an empty or partial body, not an exception. Say so
            // rather than presenting a truncated answer as complete.
            send({
              t: 'error',
              message:
                'The model declined that one and the fallback did too. Rephrasing usually clears it.',
            })
            break
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Log server-side; the client gets the message but not a stack trace.
        console.error('coach turn failed:', message)
        send({ t: 'error', message })
      } finally {
        send({ t: 'done' })
        closed = true
        controller.close()
      }
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      // Streaming through a proxy that buffers would defeat the whole point.
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  })
}
