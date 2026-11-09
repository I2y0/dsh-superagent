// nene-inbox Source：配置的形状，以及「一个目录算哪类信箱」这件事在信号路径上怎么表达。
//
// 这一层先只验纯数据（schema、信号路径、Trigger 的形状）。目录监听和 receive() 是后续步骤的事，
// 它们要验的是「投一个文件，票开不开」—— 那是集成，不是这一份。
import { describe, expect, it } from 'vitest'
import { NeneInboxConfigSchema, SOURCE, buildTrigger, neneInboxKind, signalPathOf, threadOf, wanted } from '../src/sources/nene-inbox.ts'

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

describe('一个文件 → 一条 Trigger', () => {
  const watched = { path: 'C:/nene/3-scenes/qq/inbox', role: 'qq', extensions: [] as string[], recursive: false }
  const trigger = buildTrigger(watched, '0001-a.md', 'C:/nene/3-scenes/qq/inbox/0001-a.md', 744, '2026-11-09T10:00:00.000Z')

  it('★ actor 必须是空的 —— 机器事件不能冒充人的请求', () => {
    expect(trigger.actor).toEqual({ source: SOURCE, id: '' })
    expect(trigger.human).toBe(false)
    expect(trigger.addressed).toBeUndefined()
  })

  it('★ 兼容键：mspPath 是 file.created.<role>，mspPayload 带着文件的绝对路径', () => {
    // 规则靠 mspPath 分派；sceneDirectory 靠 mspPayload.path 推场景。少一个，票就静默落到 work/task-*
    expect(trigger.meta?.mspPath).toBe('file.created.qq')
    expect((trigger.meta?.mspPayload as { path: string }).path).toBe('C:/nene/3-scenes/qq/inbox/0001-a.md')
  })

  it('★ 正文第一行是绝对路径（worker 靠它读信，不需要「领」）', () => {
    expect(trigger.text.split('\n')[0]).toBe('C:/nene/3-scenes/qq/inbox/0001-a.md')
  })

  it('★ 两封不同的信 → 两条不同的线程（不会被旧票 fanout 吃掉）', () => {
    const a = buildTrigger(watched, '0001-a.md', '/x/0001-a.md', 1, '2026-11-09T10:00:00.000Z')
    const b = buildTrigger(watched, '0002-b.md', '/x/0002-b.md', 1, '2026-11-09T10:00:01.000Z')
    expect(a.threads[0]?.id).not.toBe(b.threads[0]?.id)
  })

  it('id 含 role 与文件名，天然幂等', () => {
    expect(trigger.id).toBe('nene-inbox:qq:0001-a.md')
  })
})

describe('哪些文件算数', () => {
  const base = { path: 'C:/x', role: 'qq', recursive: false }
  it('默认全收', () => {
    expect(wanted({ ...base, extensions: [] }, 'a.md')).toBe(true)
    expect(wanted({ ...base, extensions: [] }, 'a.zip')).toBe(true)
  })
  it('配了扩展名就只收那些（大小写不敏感，带不带点都行）', () => {
    const md = { ...base, extensions: ['.MD'] }
    expect(wanted(md, 'a.md')).toBe(true)
    expect(wanted(md, 'a.zip')).toBe(false)
  })
  it('点开头的不收（编辑器临时文件 / 系统文件）', () => {
    expect(wanted({ ...base, extensions: [] }, '.DS_Store')).toBe(false)
    expect(wanted({ ...base, extensions: [] }, '.0001-a.md.swp')).toBe(false)
  })
})

// ★ 面板的 rows 表单给文本单元格的是**字符串**，不是数组。
//   只收数组的 schema 会让整个表单存不下去（空单元格 = '' → 被拒），2026-11-09 就是这样卡住的。
describe('extensions 两种写法都收', () => {
  const parse = (extensions: unknown) =>
    NeneInboxConfigSchema.parse({ dirs: [{ path: 'C:/x', role: 'qq', extensions }] }).dirs[0]!.extensions

  it('★ 空字符串（表单留空）→ 收全部', () => {
    expect(parse('')).toEqual([])
  })
  it('★ 逗号分隔的一格 → 拆成数组，去掉点和大小写', () => {
    expect(parse('MD, .Pdf')).toEqual(['md', 'pdf'])
  })
  it('★ 数组（JSON 直接写）照旧', () => {
    expect(parse(['md'])).toEqual(['md'])
  })
  it('不写 → 空数组', () => {
    expect(parse(undefined)).toEqual([])
  })
})
