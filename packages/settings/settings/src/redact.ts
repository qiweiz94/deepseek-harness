/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module @deepseek-ai/dsh-settings/redact
 */

import type z from '@deepseek-ai/schemastery'

/**
 * Minimal structural view of a live schemastery node. Only the relations the
 * redactor walks are named; everything else on the instance is ignored.
 */
interface SchemaNode {
  type?: string
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` element schema. */
  inner?: SchemaNode
  /** `union`/`intersect`/`tuple` member schemas. */
  list?: SchemaNode[]
}

/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them.
   */
  secrets: RedactedSecret[]
}

/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Define `key` as an own data property. Plain assignment on a dynamic key
 * would follow the prototype chain, so a valid JSON key such as `"__proto__"`
 * would reparent the rebuilt value instead of remaining own data.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

/** Whether a schema subtree declares `role('secret')` anywhere. */
function declaresSecret(node: SchemaNode | undefined): boolean {
  if (node === undefined) return false
  if (node.meta?.role === 'secret') return true
  if (declaresSecret(node.inner)) return true
  if ((node.list ?? []).some(declaresSecret)) return true
  return Object.values(node.dict ?? {}).some(declaresSecret)
}

/**
 * Fail-closed guard for a present value the node's declared container shape
 * cannot be applied to: with a secret anywhere in the subtree the value is
 * stripped and the container position recorded — the walker cannot locate the
 * secret inside a mismatched value, so nothing of it may cross the wire — while
 * a secret-free subtree passes the value through untouched.
 */
function guardMismatch(node: SchemaNode, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (value === undefined || !declaresSecret(node)) return value
  secrets.push({ path, set: true })
  return undefined
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  switch (node.type) {
    case 'object': {
      if (value !== undefined && !isRecord(value)) return guardMismatch(node, value, path, secrets)
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (Object.hasOwn(properties, key)) continue
          setOwn(rebuilt, key, entry)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const entry = source !== undefined && Object.hasOwn(source, key) ? source[key] : undefined
        const stripped = walk(child, entry, [...path, key], secrets)
        if (stripped !== undefined) setOwn(rebuilt, key, stripped)
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      if (!isRecord(value)) return guardMismatch(node, value, path, secrets)
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== undefined) setOwn(rebuilt, key, stripped)
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return guardMismatch(node, value, path, secrets)
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets))
    }
    default:
      // Fail closed: the walker cannot locate secret positions inside a node
      // it does not traverse (union, intersect, transform, tuple, …), so a
      // secret-declaring subtree here refuses the redaction loudly instead of
      // returning the value verbatim with nothing recording the miss.
      if (declaresSecret(node)) {
        throw new Error(`settings redaction: a role('secret') field under ${['$', ...path].join('.')} is reachable only through an unsupported "${node.type ?? 'untyped'}" schema node; declare secrets directly on fields inside object/dict/array containers`)
      }
      return value
  }
}

/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows `object`, `dict`, and `array` containers and fails closed
 * everywhere else: a secret declared under a node the walker cannot traverse
 * (union, intersect, transform, tuple, …) throws instead of leaking, and a
 * present value a secret-declaring container shape cannot be applied to is
 * stripped with its container position recorded. The input is never mutated.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema, value, [], secrets)
  return { value: stripped, secrets }
}
