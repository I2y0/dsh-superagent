// apply() 必须把 kind 注册进 SourceRegistry —— 这一条曾经被静默弄丢过。
//
// 2026-11-09：为了证明插件加载得上，apply() 里加了一个临时的 mark('register')，写成
//   ctx.effect(() => { mark('register'); return ctx.orchestrator.sources.register(neneInboxKind) }, …)
// 后来「确认加载成功，把临时诊断删掉」时，整行连同 register 一起删了。插件照样加载、不报错、
// 面板上 nene-inbox 显示 missing、信箱里的信一个都不进 Engine —— 两个小时里没有任何声音。
//
// 这一份钉住的是「注册」这个动作本身：不测配置、不测监听，只测 apply 有没有把 kind 交给 registry。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SourceContext } from '../src/sources/host.ts'
import { apply, neneInboxKind, name } from '../src/sources/nene-inbox.ts'

/** 装过的每一份假上下文，测试结束统一卸载，免得监听定时器把进程挂住。 */
const mounted: (() => unknown)[] = []
afterEach(async () => {
  for (const dispose of mounted.splice(0)) { try { await dispose() } catch { /* 卸载失败不影响断言 */ } }
})

/** 只够 apply() 用的假上下文：记下 register 收到的 kind，effect 立刻执行并留下 disposer。 */
function fakeContext() {
  const registered: unknown[] = []
  const disposers: (() => unknown)[] = []
  const source: SourceContext = {
    ready: Promise.resolve(),
    config: () => undefined,
    receive: vi.fn(),
    report: vi.fn(),
  } as unknown as SourceContext
  const orchestrator = {
    sources: { register: (kind: unknown) => { registered.push(kind); return () => { registered.splice(registered.indexOf(kind), 1) } } },
    context: () => source,
  }
  const effects = vi.fn((fn: () => unknown) => {
    const result = fn()
    const dispose = typeof result === 'function' ? result : (() => {})
    disposers.push(dispose as () => unknown)
    return dispose
  })
  const ctx = { effect: effects, orchestrator }
  mounted.push(async () => { for (const dispose of disposers) await dispose() })
  return { ctx, registered, effects }
}

describe('apply()', () => {
  it('★ 把 nene-inbox 这个 kind 注册进 registry —— 少了它，信箱一条信都进不来', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    expect(registered).toContain(neneInboxKind)
  })

  it('注册的就是这个文件导出的那个 kind，名字和 health 条目一致', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const kind = registered[0] as { kind: string; health: string[] }
    expect(kind.kind).toBe('nene-inbox')
    expect(kind.health).toEqual(['nene-inbox'])
    expect(name).toBe('dsh-superagent-nene-inbox')
  })

  it('卸载时把注册一起撤掉（ctx.effect 管生命周期，不留悬挂的 kind）', async () => {
    const { ctx, registered, effects } = fakeContext()
    apply(ctx as never)
    expect(registered).toHaveLength(1)
    // 按注册顺序卸载：registry 的 disposer 会把 kind 摘掉。
    for (const dispose of mounted.splice(0)) await dispose()
    expect(registered).toHaveLength(0)
    expect(effects).toHaveBeenCalledTimes(2)
  })

  it('★ 注册和监听是两条独立的 effect：丢一条不会把另一条带走', () => {
    const { ctx, effects } = fakeContext()
    apply(ctx as never)
    // 一条注册、一条监听。合成一条正是这次事故的形状。
    expect(effects).toHaveBeenCalledTimes(2)
  })
})
