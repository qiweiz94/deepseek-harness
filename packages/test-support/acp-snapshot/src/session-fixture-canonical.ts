/**
 * Canonical packed-row layout for session-format JSONL fixtures. Record and
 * refresh write fixtures through {@link canonicalSessionFixture} so committed
 * session logs always carry the maximal-run packed layout the repository-wide
 * snapshot gate enforces; the gate's inspector reuses the same function.
 */

import { deepStrictEqual } from 'node:assert'
import { decodeStorageRecord, packChunkRuns, type SessionEvent } from '@deepseek-ai/dsh-session'

interface RecordLine {
  line: number
  text: string
}

function recordLines(content: string): RecordLine[] {
  return content.split(/\r?\n/).flatMap((text, index) => (
    text.trim().length === 0 ? [] : [{ line: index + 1, text }]
  ))
}

function parseRecord(line: RecordLine, label: string): unknown {
  try {
    return JSON.parse(line.text) as unknown
  } catch (error) {
    /* v8 ignore next -- JSON.parse only throws Error instances; the String arm answers the unknown-typed catch. */
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}:${line.line}: invalid JSON: ${detail}`, { cause: error })
  }
}

function isSessionHeader(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'session'
}

function decodeBody(lines: readonly RecordLine[], label: string): SessionEvent[] {
  return lines.flatMap((line) => {
    const record = parseRecord(line, label)
    try {
      return decodeStorageRecord(record)
    } catch (error) {
      /* v8 ignore next -- decodeStorageRecord only throws Error instances; the String arm answers the unknown-typed catch. */
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${label}:${line.line}: invalid session storage record: ${detail}`, { cause: error })
    }
  })
}

function renderFixture(headerLine: string, events: readonly SessionEvent[]): string {
  return [
    headerLine,
    ...packChunkRuns(events).map(record => JSON.stringify(record)),
    '',
  ].join('\n')
}

/**
 * Canonicalize one JSONL document when its first record is a session header.
 * The header line remains byte-identical; body records decode to logical events
 * and re-encode with {@link packChunkRuns}. Non-session JSONL returns undefined.
 *
 * @param content - JSONL source text.
 * @param label - path-like diagnostic label.
 * @returns Canonical text for a session fixture, otherwise undefined.
 */
export function canonicalSessionFixture(content: string, label = '<session-fixture>'): string | undefined {
  const lines = recordLines(content)
  const header = lines[0]
  if (header === undefined) return undefined

  let headerValue: unknown
  try {
    headerValue = JSON.parse(header.text) as unknown
  } catch {
    // Not JSON at all, so not a session fixture; the caller keeps the document as-is.
    return undefined
  }
  if (!isSessionHeader(headerValue)) return undefined

  const events = decodeBody(lines.slice(1), label)
  const canonical = renderFixture(header.text, events)
  const canonicalLines = recordLines(canonical)
  const decoded = decodeBody(canonicalLines.slice(1), label)
  /* v8 ignore start -- packChunkRuns is lossless and idempotent by contract;
     these self-checks fail loud only if that contract breaks. */
  try {
    deepStrictEqual(decoded, events)
  } catch (error) {
    throw new Error(`${label}: packed rewrite changed the decoded event stream`, { cause: error })
  }
  if (renderFixture(header.text, decoded) !== canonical) {
    throw new Error(`${label}: packed rewrite is not idempotent`)
  }
  /* v8 ignore stop */
  return canonical
}
