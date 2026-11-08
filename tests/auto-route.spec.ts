/** Deterministic auto-route: work the deployment's rules name is decided without relaying a candidate card to the main Session. */
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MasterAssessor, type AssessorHost } from '../src/app/assessment.ts'
import { AutoRouteConfigSchema, autoRouteAssessment, loadAutoRoute, matchedPhrase } from '../src/app/auto-route.ts'
import { Engine, MemoryRepositories, type Executor, type Policy, type Trigger } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'

const CONFIG = AutoRouteConfigSchema.parse({
  enabled: true, source: 'msp', sender: 'seat', humanOnly: true,
  rules: [
    { id: 'query', prefixes: ['[查]', '[扫]'], rule: 'msp-local', worktree: 'query', scope: '只读查询，不删不移。' },
    { id: 'qq', prefixes: ['[QQ]'], rule: 'msp-local', worktree: 'qq' },
    {
      id: 'qq-dispatch', actor: '', human: false, senders: ['2116952930'], chatTypes: ['private'],
      phrases: ['让影子去', '让影子做', '派个 worker', '交给 worker'], rule: 'msp-local', worktree: 'qq',
      scope: '按消息里点名的活干。', payloadScope: false, otherwise: 'ignore',
    },
  ],
})

function dispatch(title: string, extra: Record<string, unknown> = {}, overrides: Partial<Trigger> = {}): Trigger {
  const at = '2026-11-04T04:00:00.000Z'
  return {
    id: `msp:seat:human.message:${at}:${title}`, source: 'msp', threads: [{ source: 'msp', id: 'human.message' }],
    actor: { source: 'msp', id: 'seat' }, human: true, addressed: 'direct', at, text: `human.message\n${JSON.stringify({ title, from: 'seat', ...extra })}`,
    meta: { mspPath: 'human.message', mspNode: 'seat', topic: 'human.message', mspPayload: { title, text: title, from: 'seat', ...extra } },
    ...overrides,
  }
}

/** One `work.nene.qq.message` signal as `nene-qq` publishes it: a senderless machine event carrying a person's words. */
function qq(text: string, extra: Record<string, unknown> = {}, overrides: Partial<Trigger> = {}): Trigger {
  const at = '2026-11-04T05:00:00.000Z'
  const payload = {
    title: `QQ 凉酱：${text.slice(0, 40)}`, text, chat: 'qq:user:2116952930', chatType: 'private', sender: '2116952930',
    nick: '凉酱', role: '凉酱', messageId: '1', target: '', rule: '',
    scope: '把这条 QQ 消息带进工单：读原话、按需要回；不替人做技术判断。', name: `qq-1-${text.length}`, bytes: text.length,
    ...extra,
  }
  return {
    id: `msp:nene-qq:work.nene.qq.message:${at}:${JSON.stringify(payload).slice(0, 120)}`, source: 'msp',
    threads: [{ source: 'msp', id: 'work.nene' }], actor: { source: 'msp', id: '' }, human: false, at,
    text: `work.nene.qq.message\n${JSON.stringify(payload)}`,
    meta: { mspPath: 'work.nene.qq.message', mspNode: 'nene-qq', topic: 'work.nene', mspPayload: payload },
    ...overrides,
  }
}

function harness(config: unknown = CONFIG, settings = SettingsSchema.parse({}), admission: 'explicit' | 'inferred' = 'explicit') {
  const stateDir = mkdtempSync(join(tmpdir(), 'auto-route-'))
  if (config !== undefined) writeFileSync(join(stateDir, 'auto-route.json'), JSON.stringify(config))
  const repo = new MemoryRepositories()
  const queued: { kind: string; key: string; payload: { triggerId: string } }[] = []
  const handlers = new Map<string, (payload: { triggerId: string }, key: string) => Promise<void>>()
  const delivered: string[] = []
  let engine!: Engine
  const effects = {
    enqueue: (kind: string, key: string, payload: unknown) => { queued.push({ kind, key, payload: payload as { triggerId: string } }) },
    handle: (kind: string, run: unknown) => { handlers.set(kind, run as never) },
  } as unknown as AssessorHost['effects']
  const host: AssessorHost = {
    get engine() { return engine },
    commands: {} as AssessorHost['commands'],
    deployment: testDeployment({ stateDir }),
    settings: () => settings,
    threadContext: () => undefined,
    effects,
    paused: () => false,
    deliver: async (_id, text) => { delivered.push(text) },
    candidateCard: async candidate => ({ eval_id: candidate.evalId }),
  }
  const assessor = new MasterAssessor(host)
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 600_000,
    gate: () => ({ admissible: true, strength: admission, basis: { via: 'addressed', addressed: 'direct' } }),
    revalidate: () => true, admitsInferred: () => true }
  const executor: Executor = { start: async () => {}, deliver: async () => {}, stop: async () => {} }
  const scope = { scope: () => ({ listened: true as const, observed: true }) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  engine = new Engine({ repo, policy: () => policy, scope, assessor, executor, outbox })
  /** Feeds one trigger and returns what the Eval queued. */
  const evaluate = (trigger: Trigger) => { engine.receive(trigger); engine.evaluateDue(); return queued.at(-1)! }
  /** Feeds one trigger and runs the effect it queued, the way the durable queue would. */
  const run = async (trigger: Trigger) => {
    const queuedItem = evaluate(trigger)
    for (const item of queued) {
      if (item.kind !== 'route' || item.key !== queuedItem.key) continue
      await handlers.get('route')!(item.payload, item.key)
    }
    return queuedItem
  }
  return { repo, engine, queued, handlers, delivered, evaluate, run }
}

it('accepts configured simple work without building a candidate card', async () => {
  const s = harness()
  const queued = s.evaluate(dispatch('[查] Steam 库', { task: 'tmw1abc' }))
  expect(queued.kind).toBe('route')
  await s.handlers.get('route')!(queued.payload, queued.key)
  const [ticket] = s.repo.tickets.list()
  expect(ticket).toMatchObject({ title: '[查] Steam 库', mandate: { strength: 'explicit' } })
  expect(ticket!.mandate.basis.rules).toEqual(['msp-local'])
  // The seat never saw a card: no assessment effect and no delivered candidate.
  expect(s.queued.filter(item => item.kind === 'assessment')).toEqual([])
  expect(s.delivered).toEqual([])
  expect(s.repo.decisions.byThread('msp:human.message')).toEqual([expect.objectContaining({ kind: 'accept' })])
})

it('leaves anything without a configured prefix to the seat', async () => {
  const s = harness()
  const queued = s.evaluate(dispatch('修 QQ 桥的自动回', { task: 'tmw1xyz' }))
  expect(queued.kind).toBe('assessment')
  expect(s.repo.tickets.list()).toEqual([])
})

it('does not auto-route a title whose configured Policy rule was disabled', async () => {
  const defaults = SettingsSchema.parse({})
  const settings = SettingsSchema.parse({ policy: { rules: defaults.policy.rules.map(rule =>
    rule.id === 'msp-local' ? { ...rule, enabled: false } : rule) } })
  const s = harness(CONFIG, settings)
  expect(s.evaluate(dispatch('[QQ] 回凉酱一句', { task: 'tmw1qq' })).kind).toBe('assessment')
  expect(s.repo.tickets.list()).toEqual([])
})

it('only auto-routes the configured sender, human dispatches, and batches that are all the same simple work', () => {
  const settings = SettingsSchema.parse({})
  const candidate = (triggers: Trigger[], strength: 'explicit' | 'inferred' = 'explicit') => ({ evalId: 'eval-1', thread: {} as never, triggers, strength,
    policyVersion: 'v1', tickets: [] })
  const match = (triggers: Trigger[]) => autoRouteAssessment(candidate(triggers), settings, CONFIG)
  expect(match([dispatch('[扫] C 盘大目录', { task: 'tmw1scan' })])).toMatchObject({ decision: 'accept' })
  expect(match([dispatch('[扫] C 盘大目录', {}, { actor: { source: 'msp', id: 'nene-qq' } })])).toBeUndefined()
  expect(match([dispatch('[扫] C 盘大目录', {}, { human: false })])).toBeUndefined()
  expect(match([dispatch('[查] A', { task: 'a' }), dispatch('[扫] B', { task: 'b' })])).toBeUndefined()
  // An explicit opt-out in the payload beats every rule.
  expect(match([dispatch('[查] A', { task: 'a', autoRoute: false })])).toBeUndefined()
  expect(match([dispatch('[查] A', { task: 'a' })])?.assessment.worktree_name).toMatch(/^query-[a-z0-9]{2,20}$/)
})

it('opens a ticket when a bridged chat message hands the work over', async () => {
  const s = harness(CONFIG, SettingsSchema.parse({}), 'inferred')
  const queued = await s.run(qq('让影子去做：把 QQ 桥的日志按天分文件'))
  expect(queued.kind).toBe('route')
  const [ticket] = s.repo.tickets.list()
  expect(ticket).toMatchObject({ mandate: { strength: 'inferred', basis: expect.objectContaining({ rules: ['msp-local'] }) } })
  // The ticket is named after the message the person wrote, and its worktree after the rule and the dispatch.
  expect(ticket!.title).toContain('QQ 凉酱')
  expect(autoRouteAssessment(
    { evalId: 'eval-1', thread: {} as never, triggers: [qq('让影子去做：整理表情包')], strength: 'inferred', policyVersion: 'v1', tickets: [] },
    SettingsSchema.parse({}), CONFIG)!.assessment.worktree_name).toMatch(/^qq-[a-z0-9]{4,8}$/)
  // The worker reads its scope from the rule, not from the bridge's generic "just read the message" scope.
  expect(ticket!.mandate.scope).toBe('按消息里点名的活干。')
  expect(s.queued.filter(item => item.kind === 'assessment')).toEqual([])
  expect(s.delivered).toEqual([])
  expect(s.repo.decisions.byThread('msp:work.nene')).toEqual([expect.objectContaining({ kind: 'accept' })])
})

it('closes a bridged chat message that hands no work over, without a ticket and without waking the seat', async () => {
  const s = harness(CONFIG, SettingsSchema.parse({}), 'inferred')
  const queued = await s.run(qq('姐姐，今天有点累'))
  expect(queued.kind).toBe('route')
  expect(s.repo.tickets.list()).toEqual([])
  expect(s.delivered).toEqual([])
  expect(s.queued.filter(item => item.kind === 'assessment')).toEqual([])
  const [decision] = s.repo.decisions.byThread('msp:work.nene')
  expect(decision).toMatchObject({ kind: 'ignore', strength: 'inferred', audit: expect.objectContaining({ direction: expect.objectContaining({ implementation_requested: false }) }) })
  expect(JSON.stringify(decision!.reason)).toContain('no dispatch phrase')
})

it('keeps statements and negations about a worker out of the ticket path', async () => {
  const s = harness(CONFIG, SettingsSchema.parse({}), 'inferred')
  for (const text of ['还有我让影子做的都转给它就好了', '别让影子去动那个库', '刚才让影子做完了那个']) {
    await s.run(qq(text))
  }
  expect(s.repo.tickets.list()).toEqual([])
  expect(s.delivered).toEqual([])
})

it('leaves another sender, another chat type, and a non-auto accept mode to the seat', async () => {
  const settings = SettingsSchema.parse({})
  const candidate = (trigger: Trigger) => ({ evalId: 'eval-1', thread: {} as never, triggers: [trigger], strength: 'inferred' as const,
    policyVersion: 'v1', tickets: [] })
  const match = (trigger: Trigger) => autoRouteAssessment(candidate(trigger), settings, CONFIG)
  expect(match(qq('让影子去做：整理表情包'))).toMatchObject({ decision: 'accept' })
  // A group member's "worker" talk is not 凉酱 handing work over.
  expect(match(qq('让影子去做：整理表情包', { sender: '123456' }))).toBeUndefined()
  expect(match(qq('让影子去做：整理表情包', { chatType: 'group' }))).toBeUndefined()
  // Observe mode cannot open a ticket from a machine signal, so the seat still gets the card.
  const observe = harness(CONFIG, SettingsSchema.parse({ eval: { mode: 'observe' } }), 'inferred')
  expect(observe.evaluate(qq('让影子去做：整理表情包')).kind).toBe('route')
  await observe.handlers.get('route')!(observe.queued.at(-1)!.payload, observe.queued.at(-1)!.key)
  expect(observe.repo.tickets.list()).toEqual([])
  expect(observe.queued.at(-1)!.kind).toBe('assessment')
})

it('reads a dispatch phrase case-insensitively and skips the guarded hits', () => {
  expect(matchedPhrase('派个 Worker 去干这个', ['派个 worker'])).toBe('派个 worker')
  expect(matchedPhrase('让影子去查一下 Steam 库', ['让影子去'])).toBe('让影子去')
  expect(matchedPhrase('我让影子做的都转给它了', ['让影子做'])).toBeUndefined()
  expect(matchedPhrase('别让影子去', ['让影子去'])).toBeUndefined()
  expect(matchedPhrase('这个交给 worker 了已经', ['交给 worker'])).toBe('交给 worker')
  expect(matchedPhrase('姐姐在吗', ['让影子去', '派个 worker'])).toBeUndefined()
})

it('reads an edit of the rules file on the next evaluation, and treats a malformed file as off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-route-config-'))
  const file = join(dir, 'auto-route.json')
  writeFileSync(file, JSON.stringify(CONFIG))
  expect(loadAutoRoute(dir)?.rules.map(rule => rule.id)).toEqual(['query', 'qq', 'qq-dispatch'])
  writeFileSync(file, JSON.stringify({ ...CONFIG, rules: [CONFIG.rules[0]!, { ...CONFIG.rules[1]!, prefixes: ['[回]'] }] }))
  utimesSync(file, new Date(), new Date(Date.now() + 1000))
  expect(loadAutoRoute(dir)?.rules[1]?.prefixes).toEqual(['[回]'])
  writeFileSync(file, '{ not json')
  utimesSync(file, new Date(), new Date(Date.now() + 2000))
  expect(loadAutoRoute(dir)).toBeUndefined()
})
