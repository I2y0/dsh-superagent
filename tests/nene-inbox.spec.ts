// nene-inbox Source：配置的形状，以及「一个目录算哪类信箱」这件事在信号路径上怎么表达。
//
// 这一层先只验纯数据（schema、信号路径、Trigger 的形状）。目录监听和 receive() 是后续步骤的事，
// 它们要验的是「投一个文件，票开不开」—— 那是集成，不是这一份。
import { describe, expect, it } from 'vitest'
import { NeneInboxConfigSchema, SOURCE, neneInboxKind, signalPathOf, threadOf } from '../src/sources/nene-inbox.ts'

describe('nene-inbox 的配置', () => {
  it('默认什么都不收（新装不能对机器上任何文件有反应）', () => {
    const config = NeneInboxConfigSchema.parse({})
    expect(config.dirs).toEqual([])
    expect(config.settleMs).toBe(1500)
  })

  it('目录必须带一个合法的 role —— 它拼进信号路径，脏了规则就分派不了', () => {
    expect(NeneInboxConfigSchema.safeParse({ dirs: [{ path: 'C:/x', role: 'QQ' }] }).success).toBe(false)
    expect(NeneInboxConfigSchema.safeParse({ dirs: [{ path: 'C:/x', role: 'qq' }] }).success).toBe(true)
    expect(NeneInboxConfigSchema.safeParse({ dirs: [{ path: 'C:/x' }] }).success).toBe(false)
  })

  it('不认识的键直接拒绝（今天的教训：多一个键能让整份配置静默失效）', () => {
    expect(NeneInboxConfigSchema.safeParse({ dirs: [], enabled: true }).success).toBe(false)
    expect(NeneInboxConfigSchema.safeParse({ dirs: [{ path: 'C:/x', role: 'qq', wat: 1 }] }).success).toBe(false)
  })

  it('extensions 与 recursive 有默认值', () => {
    const [entry] = NeneInboxConfigSchema.parse({ dirs: [{ path: 'C:/x', role: 'qq' }] }).dirs
    expect(entry?.extensions).toEqual([])
    expect(entry?.recursive).toBe(false)
  })
})

describe('角色落在信号路径上', () => {
  it('★ file.created.<role> —— 规则靠它分派', () => {
    expect(signalPathOf('qq')).toBe('file.created.qq')
    expect(signalPathOf('seat')).toBe('file.created.seat')
  })

  it('★ 现有的 file.** 规则照样命中（向后兼容）', () => {
    // 规则里写的是 paths: ['file.**']；只要 role 拼在后面，老规则不用改
    expect(signalPathOf('scene')).toMatch(/^file\.created\./)
  })
})

describe('线程每封信一条', () => {
  it('★ 同一个 role 的两封不同信，线程不同 —— 这样不会被旧票 fanout 吃掉', () => {
    expect(threadOf('qq', '0001-a.md')).not.toBe(threadOf('qq', '0002-b.md'))
  })

  it('★ 同名信在线程上也唯一（同目录不会重名，跨目录靠 role 区分）', () => {
    expect(threadOf('qq', '0001-a.md')).toBe(threadOf('qq', '0001-a.md'))
    expect(threadOf('qq', '0001-a.md')).not.toBe(threadOf('seat', '0001-a.md'))
  })
})

describe('kind 的形状', () => {
  it('source 名与 health 条目是同一个字符串', () => {
    expect(neneInboxKind.kind).toBe(SOURCE)
    expect(neneInboxKind.health).toEqual([SOURCE])
  })

  it('★ scope 恒为「全听全看、ambient 行」—— 和 msp 一样，写错了会静默不开票', () => {
    expect(neneInboxKind.scope?.({ meta: {} }, NeneInboxConfigSchema.parse({}))).toEqual({ listened: true, observed: true, row: 'ambient' })
  })
})
