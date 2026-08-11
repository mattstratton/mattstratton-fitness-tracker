/**
 * The wire format between /api/coach and the /ask page.
 *
 * Server-Sent Events, but driven by a POST (the request carries the conversation,
 * which `EventSource` cannot send), so the client reads
 * `response.body.getReader()` rather than using `EventSource`. That means the
 * framing is ours to get right, and the framing is the part with a bug in it if
 * anything here is wrong -- hence pure functions with tests rather than inline
 * string handling in a component.
 */

/** One message from the server to the chat UI. */
export type CoachEvent =
  /** Summarised reasoning, streamed as a transient status line. */
  | { t: 'thinking'; delta: string }
  /** Answer text. */
  | { t: 'text'; delta: string }
  /** A tool started running. Shown so a long turn visibly does something. */
  | { t: 'tool'; name: string }
  /** Something went wrong; the turn is over. */
  | { t: 'error'; message: string }
  /** The turn completed normally. */
  | { t: 'done' }

/**
 * Frame one event.
 *
 * JSON-encoding the payload is what makes this safe: SSE terminates a message at
 * a blank line, so a delta containing a newline -- which answer text does
 * constantly, and reasoning summaries do more -- would split one message into two
 * malformed ones if written raw. `JSON.stringify` escapes it to `\n`, so the
 * payload is always exactly one line.
 */
export function encodeEvent(event: CoachEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * Pull whole events out of a stream chunk, returning whatever is left over.
 *
 * A chunk boundary can fall anywhere, including mid-JSON, so the caller threads
 * the returned `buffer` into the next call. Malformed payloads are skipped rather
 * than thrown: a dropped frame degrades one status line, whereas throwing kills
 * the whole answer mid-sentence.
 */
export function decodeChunk(
  buffer: string,
  chunk: string,
): { events: CoachEvent[]; buffer: string } {
  const combined = buffer + chunk
  const parts = combined.split('\n\n')
  // The final part is either empty (the chunk ended on a boundary) or a partial
  // event still being received. Either way it is not ours to parse yet.
  const rest = parts.pop() ?? ''
  const events: CoachEvent[] = []

  for (const part of parts) {
    const line = part.trim()
    if (!line.startsWith('data:')) continue
    try {
      events.push(JSON.parse(line.slice(5).trim()) as CoachEvent)
    } catch {
      // Skip it. See above.
    }
  }

  return { events, buffer: rest }
}
