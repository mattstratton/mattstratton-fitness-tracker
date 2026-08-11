'use client'

/**
 * The coaching chat, client side.
 *
 * Ephemeral by design in v1: the transcript lives in component state and is gone
 * on reload. Persistence is a follow-up -- it needs a table, and the interesting
 * half of #8 is whether the answers are any good, not whether they survive a
 * refresh.
 *
 * The whole transcript is POSTed on every turn. The API is stateless (see
 * app/api/coach/route.ts) and history is text-only: prior tool calls are not
 * replayed, so a follow-up re-reads the database rather than reasoning over a
 * stale snapshot.
 */
import { useEffect, useRef, useState } from 'react'

import { decodeChunk } from '../../lib/coach/stream.js'

type Message = { role: 'user' | 'assistant'; content: string }

/** `get_weight_trend` -> `weight trend`. Enough to make the status line readable
 *  without maintaining a display-name map that drifts from the tool list. */
function prettyTool(name: string): string {
  return name.replace(/^(get|list)_/, '').replace(/_/g, ' ')
}

const SUGGESTIONS = [
  'How am I doing?',
  "How's my protein been this week?",
  'Am I progressing on bench?',
  'What is my weight actually doing?',
]

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, status])

  async function send(question: string): Promise<void> {
    const trimmed = question.trim()
    if (trimmed === '' || busy) return

    const history: Message[] = [...messages, { role: 'user', content: trimmed }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setInput('')
    setError(null)
    setBusy(true)
    setStatus('thinking')

    // Accumulated locally rather than by appending to state per delta: React
    // batches, and reading the previous assistant message out of state on every
    // token is both slower and easy to get subtly wrong.
    let answer = ''
    let thinking = ''

    const replaceLast = (content: string): void => {
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { role: 'assistant', content }
        return next
      })
    }

    try {
      const response = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      })

      if (!response.ok || response.body === null) {
        // The route returns JSON, not SSE, for anything it rejects outright.
        const detail = await response.text().catch(() => '')
        throw new Error(
          response.status === 401
            ? 'Not signed in.'
            : `Request failed (${response.status}). ${detail.slice(0, 200)}`,
        )
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const decoded = decodeChunk(buffer, decoder.decode(value, { stream: true }))
        buffer = decoded.buffer

        for (const event of decoded.events) {
          if (event.t === 'text') {
            answer += event.delta
            // Reasoning is a progress indicator, not content -- once real answer
            // text starts arriving it has served its purpose.
            setStatus(null)
            replaceLast(answer)
          } else if (event.t === 'thinking') {
            thinking += event.delta
            if (answer === '') setStatus(thinking.trim().split('\n').pop() ?? 'thinking')
          } else if (event.t === 'tool') {
            if (answer === '') setStatus(`reading ${prettyTool(event.name)}`)
          } else if (event.t === 'error') {
            setError(event.message)
          } else if (event.t === 'done') {
            break
          }
        }
      }

      // A turn that produced no text at all is a failure, and leaving an empty
      // assistant bubble on screen would present it as an answer.
      if (answer === '') {
        setMessages(history)
        setError((prev) => prev ?? 'No answer came back. Try again.')
      }
    } catch (err) {
      setMessages(history)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <div className="chat">
      {messages.length === 0 && (
        <div className="chat-empty">
          <p className="empty">
            Ask about training, food, weight, recovery — anything in the data. Every
            number in an answer comes from a query you can audit in{' '}
            <code>lib/coach/tools.ts</code>; it has no way to change your program or
            your targets, and &ldquo;not enough data yet&rdquo; is an answer it is
            allowed to give.
          </p>
          <div className="chat-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {messages.map((m, i) => (
        <div key={i} className="turn" data-role={m.role}>
          {m.content === '' ? <span className="cursor" /> : m.content}
        </div>
      ))}

      {status !== null && <p className="chat-status">{status}</p>}
      {error !== null && <p className="chat-error">{error}</p>}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the data…"
          disabled={busy}
          autoComplete="off"
          // Keeps iOS from zooming the viewport on focus, which on a phone in a
          // garage is the difference between usable and not.
          style={{ fontSize: '16px' }}
        />
        <button type="submit" disabled={busy || input.trim() === ''}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>
      <div ref={endRef} />
    </div>
  )
}
