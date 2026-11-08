/** MSP source: signal → Trigger mapping and the ambient admission row. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mspTrigger, topicOf, mspKind, SOURCE } from '../lib/msp-watch.js'

const config = { humanPaths: ['human.message', 'notify.message'] }

describe('msp source', () => {
  it('derives the topic from the first two path segments', () => {
    assert.equal(topicOf('file.created.C:\\x\\y.zip'), 'file.created')
    assert.equal(topicOf('notify.message'), 'notify.message')
    assert.equal(topicOf('tick'), 'tick')
  })

  it('maps one signal to one Trigger on the topic thread', () => {
    const t = mspTrigger({ node: 'file-watcher', path: 'file.modified', at: '2026-10-31T10:00:00.000Z', payload: { name: 'a.png' } }, config)
    assert.ok(t)
    assert.equal(t.source, SOURCE)
    assert.equal(t.threads[0].id, 'file.modified')
    assert.equal(t.at, '2026-10-31T10:00:00.000Z')
    assert.match(t.text, /file\.modified/)
  })

  it('treats a machine signal as senderless, not as a person asking', () => {
    const t = mspTrigger({ node: 'file-watcher', path: 'file.modified', payload: {} }, config)
    assert.equal(t.human, false)
    assert.equal(t.actor.id, '', 'senderless: no one is asking for work')
    assert.equal(t.addressed, undefined)
  })

  it('marks a human channel as a human, addressed trigger', () => {
    const t = mspTrigger({ node: 'im-bridge', path: 'notify.message', payload: { text: 'hi' } }, config)
    assert.equal(t.human, true)
    assert.equal(t.actor.id, 'im-bridge')
    assert.equal(t.addressed, 'direct')
  })

  it('is deterministic, so a bridge replay does not double-open work', () => {
    const e = { node: 'w', path: 'file.modified', at: '2026-10-31T10:00:00.000Z', payload: { a: 1 } }
    assert.equal(mspTrigger(e, config).id, mspTrigger(e, config).id)
  })

  it('parses a whole line without throwing', () => {
    const line = '{"node":"w","path":"file.created","at":"2026-10-31T10:00:00Z","payload":{"n":1}}'
    const t = mspTrigger(JSON.parse(line), config)
    assert.ok(t)
    assert.equal(t.threads[0].id, 'file.created')
  })

  it('ignores a line with no path', () => {
    assert.equal(mspTrigger({ node: 'w' }, config), undefined)
  })

  it('scopes every signal as observed, under the ambient admission row', () => {
    assert.deepEqual(mspKind.scope?.({ meta: {} }, { humanPaths: [] }), { listened: true, observed: true, row: 'ambient' })
    assert.deepEqual(mspKind.health, ['msp'])
    assert.equal(mspKind.kind, 'msp')
  })
})
