// notify 出口：规则说「告诉那个场景的会话」，而不是开票。
//
// 这一层要钉住两件事：
//   ① 规则配了 notify，autoRouteAssessment 就返回第三种决策，且**不带票**
//   ② 场景 → 会话的映射从 areas.json 读（它才是跟着换届变的那份），读不到就不许静默丢信
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { autoRouteAssessment, letterNotice, loadAutoRoute, sceneSession } from '../src/app/auto-route.ts'

const dir = mkdtempSync(join(tmpdir(), 'notify-exit-'))
// sceneFrom 要求目录真实存在：造一个 3-scenes/qq，accept 那条用例才有地方落
const qqDir = join(dir, '3-scenes', 'qq')
mkdirSync(join(qqDir, 'inbox'), { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const settings = { policy: { rules: [{ id: 'msp-local', enabled: true }] } } as never
const rule = (extra: Record<string, unknown> = {}) => ({
  id: 'seat-inbox', source: 'nene-inbox', prefixes: [], phrases: [], paths: ['file.created.seat'], sceneFromPath: false,
  notify: true, senders: [], chatTypes: [], rule: 'msp-local', worktree: 'seat',
  payloadScope: true, otherwise: 'card' as const, actor: '', human: false, ...extra,
})
const config = (one: Record<string, unknown>, notifyAreas: string | null = null) =>
  ({ enabled: true, source: 'msp', sender: 'seat', humanOnly: false, rules: [one as never], notifyAreas })

/** 一条 file.created.seat 机器信号，payload 指到座位信箱里的一封。 */
const signal = (file: string) => ({
  id: 'trigger-1', source: 'nene-inbox', human: false, at: '2026-11-09T10:00:00.000Z', text: '',
  threads: [{ source: 'nene-inbox', id: 'inbox.seat.0001-a.md' }],
  actor: { source: 'nene-inbox', id: '' },
  meta: { mspPath: 'file.created.seat', mspPayload: { name: '0001-a.md', path: file, bytes: 12 } },
})

describe('notify 是第三种出口', () => {
  it('★ 配了 notify 的规则命中 → decision=notify，带 scene 与文件路径', () => {
    const choice = autoRouteAssessment({ triggers: [signal('C:/nene/2-shared/seat-inbox/0001-a.md')] } as never,
      settings, config(rule()) as never)
    expect(choice?.decision).toBe('notify')
    expect(choice?.notify?.path).toBe('C:/nene/2-shared/seat-inbox/0001-a.md')
    expect(choice?.notify?.title).toBe('0001-a.md')
  })

  it('★ 同样一条规则不配 notify → 回到 accept（开票），行为不变', () => {
    const choice = autoRouteAssessment({ triggers: [signal(join(qqDir, 'inbox', '0001-a.md'))] } as never,
      settings, config(rule({ notify: false, sceneFromPath: true })) as never)
    expect(choice?.decision).toBe('accept')
    expect(choice?.notify).toBeUndefined()
  })

  it('★ notify 也要有场景：信号路径里没有 role 时，不会变成 notify', () => {
    // 场景从 role 取（file.created.<role>）；路径不是这个形状，就没有会话可送
    const noRole = { ...signal('C:/Downloads/a.md'), meta: { mspPath: 'notify.message', mspPayload: { name: 'a.md', path: 'C:/Downloads/a.md', bytes: 1 } } }
    const choice = autoRouteAssessment({ triggers: [noRole] } as never, settings, config(rule()) as never)
    expect(choice?.decision).not.toBe('notify')
  })
})

describe('场景 → 会话 从 areas.json 读', () => {
  const file = join(dir, 'areas.json')
  writeFileSync(file, JSON.stringify({ areas: [
    { scene: 'nene', sceneId: 'nene', session: 'session-seat', role: 'nene' },
    { scene: 'qq', sceneId: 'qq', session: 'session-qq', role: 'shadow' },
    { scene: '我的工坊', sceneId: 'workshop', session: 'session-workshop', role: 'shadow' },
  ] }))

  it('★ 按 sceneId 取，取到的是 shadow 那条', () => {
    expect(sceneSession(file, 'qq')).toBe('session-qq')
    expect(sceneSession(file, 'workshop')).toBe('session-workshop')
  })

  it('★ 不会把座位自己（role=nene）当成某个场景的会话', () => {
    expect(sceneSession(file, 'nene')).toBeUndefined()
  })

  it('没配置 / 读不到 / 没这个场景 → undefined（调用方据此降级开票，不许静默丢信）', () => {
    expect(sceneSession(null, 'qq')).toBeUndefined()
    expect(sceneSession(join(dir, 'nope.json'), 'qq')).toBeUndefined()
    expect(sceneSession(file, 'ghost')).toBeUndefined()
  })
})

describe('送给会话的那句话', () => {
  it('★ 只给文件名和路径 —— 信本身才是消息，摘要会变成它的第二份副本', () => {
    const text = letterNotice({ scene: 'seat', title: '0001-a.md', path: 'C:/x/0001-a.md' })
    expect(text).toContain('0001-a.md')
    expect(text).toContain('C:/x/0001-a.md')
    expect(text).toContain('seat')
  })
})

describe('配置层的 notifyAreas', () => {
  it('★ notifyAreas 默认空 = notify 不可用（新装不会去读别人的文件）', () => {
    writeFileSync(join(dir, 'auto-route.json'), JSON.stringify({ enabled: true, rules: [rule()] }))
    expect(loadAutoRoute(dir)?.notifyAreas).toBeNull()
  })

  it('写了就带出来', () => {
    writeFileSync(join(dir, 'auto-route.json'), JSON.stringify({ enabled: true, rules: [rule()], notifyAreas: 'C:/nene/2-shared/areas.json' }))
    expect(loadAutoRoute(dir)?.notifyAreas).toBe('C:/nene/2-shared/areas.json')
  })
})

// ★ 迁移期的硬约束：顶层 source 只有一个，而 msp（派活/QQ）和 nene-inbox（信箱）要同时活着。
describe('规则可以声明自己服务哪个 Source', () => {
  it('★ 规则写了 source，就用规则的（顶层仍是 msp）', () => {
    const choice = autoRouteAssessment({ triggers: [signal('C:/x/0001-a.md')] } as never,
      settings, config(rule({ source: 'nene-inbox' })) as never)
    expect(choice?.decision).toBe('notify')
  })

  it('★ 规则属于别的 Source → 这条规则不说话（不会替另一条路的信号决定）', () => {
    const choice = autoRouteAssessment({ triggers: [signal('C:/x/0001-a.md')] } as never,
      settings, config(rule({ source: 'msp' })) as never)
    expect(choice).toBeUndefined()
  })

  it('★ 没写 source 就沿用顶层的（老规则行为不变）', () => {
    const inherited = autoRouteAssessment(
      { triggers: [{ ...signal('C:/x/0001-a.md'), source: 'msp' }] } as never,
      settings, config(rule({ source: undefined })) as never)
    expect(inherited?.decision).toBe('notify')
  })
})
