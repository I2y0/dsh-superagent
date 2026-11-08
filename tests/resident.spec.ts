import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, RESIDENT_RULES, RESIDENT_WEEK_MS, idleResident, rotationOf, rotationReason, runningAssignment }
  from '../src/core/index.ts'
import type { Assignment, Candidate, Executor, Outcome, Policy, Ticket, Trigger } from '../src/core/index.ts'

const member = { source: 'chat', id: 'alice' }
const DAY = 24 * 60 * 60 * 1000
/** The rules the residency tests run under: residency on, with the production defaults for the cleaning rules. */
const RULES = { ...RESIDENT_RULES, enabled: true }
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true,
    at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {},
    ...overrides }
}
/** An Engine over MemoryRepositories with a fake Executor, a clock the test moves, and the resident rules it passes in. */
function harness(rules: Partial<Policy['resident']> = {}, overrides: Partial<Policy> = {}) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const launches: [Ticket, Assignment][] = [], deliveries: string[] = [], stops: string[] = []
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }),
    deliver: vi.fn(ticket => { deliveries.push(ticket.id) }),
    stop: vi.fn(ticket => { stops.push(ticket.id) }),
  }
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: t => t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => true, admitsInferred: matched => matched.length > 0,
    resident: { ...RULES, ...rules }, ...overrides,
  }
  let clock = Date.parse('2026-09-23T00:00:00Z')
  const engine = new Engine({
    repo, policy: () => policy, assessor: { request: candidate => { requests.push(candidate) } },
    scope: { scope: () => ({ listened: true, observed: false }) }, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    prepareTicket: ticket => ({ ...ticket, execution: { name: `work-${ticket.id}`, directory: `/work/${ticket.id}`, assignment: '' } }),
    now: () => new Date(clock).toISOString(),
  })
  /** Start queued Assignments and hand pending Inputs to a running one, as the Executor does. */
  function settle() {
    for (;;) {
      const next = launches.shift()
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const ticketId = deliveries.shift()
      if (ticketId === undefined) return
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (!assignment) continue
      for (const inputId of ticket.undelivered) engine.inputsDelivered(ticketId, assignment.id, [inputId])
    }
  }
  const pump = () => { engine.evaluateDue(); settle() }
  const accept = (id: string, thread = 't1'): Ticket => {
    engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] })); pump()
    const outcome: Outcome = { kind: 'accept', title: `Work ${id}`, scope: 'small', reason: 'requested', acknowledgement: 'ok' }
    const candidate = requests.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId }) as { ticketId: string }
    settle()
    return repo.tickets.get(decision.ticketId)!
  }
  return { engine, repo, accept, settle, stops, deliveries, tick: (ms: number) => { clock += ms } }
}
const ready = (h: ReturnType<typeof harness>, ticketId: string) => { h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle() }

describe('rotationReason', () => {
  const state = (overrides: Partial<NonNullable<Ticket['resident']>> = {}) => ({ since: '2026-09-23T00:00:00.000Z', rounds: 1, ...overrides })
  it('leaves a ticket resident while no rule fires', () => {
    expect(rotationReason({ resident: state() }, RULES, '2026-09-23T00:00:01.000Z')).toBeUndefined()
    expect(rotationReason({ resident: undefined }, RULES, '2026-09-23T00:00:01.000Z')).toBeUndefined()
  })
  it('rotates after the item count', () => {
    expect(rotationReason({ resident: state({ rounds: 9 }) }, RULES, '2026-09-23T00:00:01.000Z')).toBeUndefined()
    expect(rotationReason({ resident: state({ rounds: 10 }) }, RULES, '2026-09-23T00:00:01.000Z')).toBe('rounds')
    expect(rotationReason({ resident: state({ rounds: 99 }) }, { ...RULES, maxRounds: 0 }, '2026-09-23T00:00:01.000Z')).toBeUndefined()
  })
  it('rotates when the worker context filled', () => {
    expect(rotationReason({ resident: state({ contextPercent: 79 }) }, RULES, '2026-09-23T00:00:01.000Z')).toBeUndefined()
    expect(rotationReason({ resident: state({ contextPercent: 80 }) }, RULES, '2026-09-23T00:00:01.000Z')).toBe('context')
    expect(rotationReason({ resident: state({ contextPercent: 100 }) }, { ...RULES, maxContextPercent: 0 }, '2026-09-23T00:00:01.000Z')).toBeUndefined()
  })
  it('rotates after an error since the last item, before the other rules', () => {
    expect(rotationReason({ resident: state({ error: true, rounds: 10 }) }, RULES, '2026-09-23T00:00:01.000Z')).toBe('error')
    expect(rotationReason({ resident: state({ error: true }) }, { ...RULES, onError: false }, '2026-09-23T00:00:01.000Z')).toBeUndefined()
  })
  it('rotates a week after it became resident', () => {
    const at = new Date(Date.parse('2026-09-23T00:00:00Z') + RESIDENT_WEEK_MS - 1).toISOString()
    expect(rotationReason({ resident: state() }, RULES, at)).toBeUndefined()
    expect(rotationReason({ resident: state() }, RULES, new Date(Date.parse(at) + 1).toISOString())).toBe('weekly')
    expect(rotationReason({ resident: state() }, { ...RULES, weekly: false }, new Date(Date.parse(at) + 1).toISOString())).toBeUndefined()
  })
  it('records its reason in the end and reads it back', () => {
    expect(rotationOf('rotation:rounds')).toBe('rounds')
    expect(rotationOf('rotation:scenario')).toBe('scenario')
    expect(rotationOf('done')).toBeUndefined()
    expect(rotationOf(undefined)).toBeUndefined()
  })
})

describe('a resident ticket', () => {
  it('stays open after its work item, with its worker session, instead of ending', () => {
    const h = harness()
    const ticket = h.accept('1')
    ready(h, ticket.id)
    const after = h.repo.tickets.get(ticket.id)!
    expect(after.ended).toBeUndefined()
    expect(idleResident(after)).toBe(true)
    expect(after.resident?.rounds).toBe(1)
    expect(after.resident?.outcome).toBe('completed')
    expect(runningAssignment(after)?.state).toBe('running')
    expect(h.stops).toEqual([])
  })
  it('takes a new Trigger on its Thread as new work, without a new ticket or assignment', () => {
    const h = harness()
    const ticket = h.accept('1')
    ready(h, ticket.id)
    h.engine.receive(trigger('2')); h.settle()
    const after = h.repo.tickets.get(ticket.id)!
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(idleResident(after)).toBe(false)
    expect(after.inputs.some(input => input.kind === 'trigger' && input.triggerId === '2')).toBe(true)
    expect(runningAssignment(after)?.id).toBe(ticket.assignments[0]!.id)
    expect(after.undelivered).toEqual([])
  })
  it('holds notes and Policy changes while it waits, and delivers them with its next work', () => {
    const h = harness()
    const ticket = h.accept('1')
    ready(h, ticket.id)
    h.engine.policyChanged('v1', 'v2', new Map([[ticket.id, { proactive: false as const }]]))
    expect(h.repo.tickets.get(ticket.id)!.undelivered).toHaveLength(1)
    expect(h.deliveries).toEqual([])
    h.engine.receive(trigger('2')); h.settle()
    const after = h.repo.tickets.get(ticket.id)!
    expect(after.undelivered).toEqual([])
    expect(after.inputs.map(input => input.kind)).toEqual(expect.arrayContaining(['policy-changed', 'trigger']))
  })
  it('rotates after the item count and hands the next ticket its memory.md', () => {
    const h = harness({ maxRounds: 2 })
    const first = h.accept('1')
    ready(h, first.id)
    expect(h.repo.tickets.get(first.id)!.ended).toBeUndefined()
    h.engine.receive(trigger('2')); h.settle()
    ready(h, first.id)
    const rotated = h.repo.tickets.get(first.id)!
    expect(rotated.ended?.reason).toBe('rotation:rounds')
    expect(h.stops).toEqual([first.id])
    const next = h.accept('3')
    expect(next.id).not.toBe(first.id)
    const handoff = next.inputs.find(input => input.kind === 'note' && input.text.includes('Resident handoff'))
    expect(handoff).toBeDefined()
    expect(handoff!.kind === 'note' && handoff!.text).toContain(`/work/${first.id}/memory.md`)
    // It went out with the new ticket's launch, not waiting for a person.
    expect(next.undelivered).not.toContain(handoff!.id)
  })
  it('rotates after an error', () => {
    const h = harness()
    const ticket = h.accept('1')
    h.engine.report(ticket.id, { state: 'failed', summary: 'broke' })
    ready(h, ticket.id)
    expect(h.repo.tickets.get(ticket.id)!.ended?.reason).toBe('rotation:error')
  })
  it('rotates when its worker context filled', () => {
    const h = harness()
    const ticket = h.accept('1')
    h.engine.contextUsage(ticket.id, 85)
    ready(h, ticket.id)
    expect(h.repo.tickets.get(ticket.id)!.ended?.reason).toBe('rotation:context')
  })
  it('rotates a week after it became resident', () => {
    const h = harness()
    const ticket = h.accept('1')
    h.tick(RESIDENT_WEEK_MS + DAY)
    ready(h, ticket.id)
    expect(h.repo.tickets.get(ticket.id)!.ended?.reason).toBe('rotation:weekly')
  })
  it('rotates when a new ticket starts work in another scenario', () => {
    const h = harness()
    const first = h.accept('1', 't1')
    ready(h, first.id)
    const second = h.accept('2', 't2')
    expect(h.repo.tickets.get(first.id)!.ended?.reason).toBe('rotation:scenario')
    expect(second.id).not.toBe(first.id)
    expect(second.ended).toBeUndefined()
  })
  it('ends as before when residency is disabled', () => {
    const h = harness({ enabled: false })
    const ticket = h.accept('1')
    ready(h, ticket.id)
    expect(h.repo.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
  })
})
