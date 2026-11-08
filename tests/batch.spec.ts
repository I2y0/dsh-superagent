/** Dispatch batches: work one request split into several tickets reports to the main Session once, when its last ticket has. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { feishu, seedLessons, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** The relays delivered to the main Session, as the messages a person's Session reads. */
const relays = () => h.relays(h.runtime.masterId)
/** Accept several triggers in one call, as a request split into tickets is dispatched. */
async function dispatch(...triggers: Trigger[]): Promise<Ticket[]> {
  for (const trigger of triggers) h.runtime.receive(trigger)
  await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: triggers.map((trigger, index) => ({
    kind: 'accept', trigger_id: trigger.id, title: `Task ${index + 1}`, worktree_name: 'fix-regression', acknowledgement: '收到。' })) }) as
    { results: { ticket: { ticket_id: string } }[] }
  const tickets = results.map(result => h.runtime.store.tickets.get(result.ticket.ticket_id)!)
  // A report that ends a ticket's work keeps its lessons file, which the report is checked against.
  for (const ticket of tickets) seedLessons(ticket.execution!.directory)
  await h.runtime.idle()
  return tickets
}
const report = (ticket: Ticket, args: Record<string, unknown>) => h.runTool(workerSessionId(ticket.id), 'orchestrator_report', args)
/** Waits until the relays queued so far reached the main Session. */
const settle = async () => { await h.runtime.effects.idle('relay'); await h.runtime.idle() }

it('reports a batch once, with every ticket\'s result, when its last ticket has reported', async () => {
  const tickets = await dispatch(feishu('1', '@bot 修一下回归'), feishu('2', '@bot 再修一个'))
  const [first, second] = tickets as [Ticket, Ticket]
  expect(first.batch).toBe(second.batch)
  expect(first.batch).toMatch(/^b-/)
  const before = relays().length
  await report(first, { state: 'ready', summary: 'First is fixed.' })
  await settle()
  // The first ticket's result waits for the batch: nothing wakes the main Session yet.
  expect(relays().slice(before)).toEqual([])
  await report(second, { state: 'ready', summary: 'Second is fixed too.' })
  await settle()
  const sent = relays().slice(before).filter(item => item.kind !== 'candidate')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toEqual({ kind: 'batch_report', batch: first.batch, tickets: [
    { ticket_id: first.id, title: 'Task 1', state: 'completed', result: 'First is fixed.', read: `ticket/${first.id}/result` },
    { ticket_id: second.id, title: 'Task 2', state: 'completed', result: 'Second is fixed too.', read: `ticket/${second.id}/result` },
  ], note: expect.stringContaining('Every Ticket of this batch has reported') })
})

it('groups tickets by a batch named in the call, and still reports a lone accept at once', async () => {
  const alone = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  expect(alone.ticket.batch).toBeUndefined()
  const before = relays().length
  await report(alone.ticket, { state: 'ready', summary: 'Done alone.' })
  await settle()
  expect(relays().slice(before)).toEqual([expect.objectContaining({ kind: 'worker_report', state: 'ready', summary: 'Done alone.' })])
  // Two accepts in separate calls share the batch this call names.
  const one = feishu('2', '@bot 做第一件'), two = feishu('3', '@bot 做第二件')
  const accept = async (trigger: Trigger) => {
    h.runtime.receive(trigger)
    await h.runtime.idle()
    const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id,
      title: 'Split', worktree_name: 'fix-regression', acknowledgement: '收到。', batch: 'request-7' }] }) as { results: { ticket: { ticket_id: string } }[] }
    const ticket = h.runtime.store.tickets.get(results[0]!.ticket.ticket_id)!
    seedLessons(ticket.execution!.directory)
    await h.runtime.idle()
    return ticket
  }
  const [a, b] = [await accept(one), await accept(two)]
  expect([a.batch, b.batch]).toEqual(['request-7', 'request-7'])
  const start = relays().length
  await report(a, { state: 'ready', summary: 'The first half.' })
  await settle()
  expect(relays().slice(start)).toEqual([])
  await report(b, { state: 'ready', summary: 'The second half.' })
  await settle()
  expect(relays().slice(start).filter(item => item.kind === 'batch_report')).toEqual([expect.objectContaining({ batch: 'request-7',
    tickets: [expect.objectContaining({ ticket_id: a.id, result: 'The first half.' }), expect.objectContaining({ ticket_id: b.id, result: 'The second half.' })] })])
})

it('reports an urgent ticket at once, and still carries it in the batch message', async () => {
  const urgent = feishu('1', '@bot 先修这个')
  const routine = feishu('2', '@bot 再修那个')
  // The dispatch `派活.mjs --urgent` publishes: the Executor reads the ticket's urgency from the MSP payload.
  urgent.meta = { ...urgent.meta, mspPayload: { urgent: true } }
  const [first, second] = await dispatch(urgent, routine) as [Ticket, Ticket]
  expect(first.urgent).toBe(true)
  expect(second.urgent).toBeUndefined()
  const before = relays().length
  await report(first, { state: 'ready', summary: 'The urgent one is fixed.' })
  await settle()
  // The urgent ticket's result does not wait for its batch.
  expect(relays().slice(before)).toMatchObject([{ kind: 'worker_report', ticket: { ticket_id: first.id }, state: 'ready',
    summary: 'The urgent one is fixed.' }])
  const told = relays().length
  await report(second, { state: 'ready', summary: 'The other one is fixed too.' })
  await settle()
  const batch = relays().slice(told).filter(item => item.kind === 'batch_report')
  expect(batch).toHaveLength(1)
  expect(batch[0]).toMatchObject({ tickets: [
    expect.objectContaining({ ticket_id: first.id, state: 'completed', result: 'The urgent one is fixed.' }),
    expect.objectContaining({ ticket_id: second.id, state: 'completed', result: 'The other one is fixed too.' }),
  ] })
})

it('does not treat a malformed urgent payload as urgent', async () => {
  const bogus = feishu('1', '@bot 还是常规活')
  bogus.meta = { ...bogus.meta, mspPayload: { urgent: 'true' } }
  const [ticket] = await dispatch(bogus, feishu('2', '@bot 另一张')) as [Ticket, Ticket]
  expect(ticket.urgent).toBeUndefined()
})

it('does not hold a question, or a blocked report, from a ticket whose batch still works', async () => {
  const [first, second] = await dispatch(feishu('1', '@bot 修一下回归'), feishu('2', '@bot 再修一个')) as [Ticket, Ticket]
  const before = relays().length
  await report(first, { state: 'progress', summary: 'Which desktop?', human_action: 'Desktop too?' })
  await settle()
  expect(relays().slice(before).map(item => item.kind)).toEqual(['worker_attention'])
  const blocked = relays().length
  await report(second, { state: 'blocked', summary: 'The build needs a secret.' })
  await settle()
  expect(relays().slice(blocked)).toEqual([expect.objectContaining({ kind: 'worker_report', state: 'blocked' })])
  // Once its last ticket reports, the batch's one message carries both, so nothing is lost by holding a routine result.
  await report(first, { state: 'ready', summary: 'Fixed with the default.' })
  await settle()
  const batch = relays().slice(before).filter(item => item.kind === 'batch_report')
  expect(batch).toHaveLength(1)
  expect(batch[0]).toMatchObject({ tickets: [
    expect.objectContaining({ ticket_id: first.id, state: 'completed', result: 'Fixed with the default.' }),
    expect.objectContaining({ ticket_id: second.id, state: 'person/blocked', result: 'The build needs a secret.' }),
  ] })
})
