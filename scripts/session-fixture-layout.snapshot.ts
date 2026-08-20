/** Repository-wide canonical-layout check for committed session fixtures. */

import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { inspectSessionFixtureLayouts } from './session-fixture-layout.ts'

const root = resolve(import.meta.dirname, '..')

it('keeps every session-format JSONL fixture in canonical packed layout', () => {
  const nonCanonical = inspectSessionFixtureLayouts(root)
    .filter(fixture => fixture.source !== fixture.canonical)
    .map(fixture => fixture.path)
  expect(
    nonCanonical,
    'Rewrite the fixture in the canonical packed-row layout: record/refresh write it directly, and canonicalSessionFixture (@deepseek-ai/dsh-acp-snapshot) converts an existing log.',
  ).toEqual([])
})
