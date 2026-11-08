// 工单 0019-B：按信号路径派场景（`/3-scenes/<id>/` → {id, dir}）
//
// 为什么单独一个 spec：这条规则要能「不靠 payload 塞字段就把活派给对的场景」，
// 而它的失败方式很安静 —— 推不出场景时票会退到 execution root，场景就散了，没人会报错。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterAll } from 'vitest'
import { autoRouteAssessment, loadAutoRoute, matchesPath, resolveForTest, sceneFromForTest } from '../src/app/auto-route.ts'

const root = mkdtempSync(join(tmpdir(), 'scene-from-path-'))
const qqDir = join(root, '3-scenes', 'qq')
const tokenDir = join(root, '3-scenes', 'token')
mkdirSync(qqDir, { recursive: true })
mkdirSync(tokenDir, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 一条只按路径说话的规则：无发送者、非人、盯 `file.**`、场景从路径推。 */
const rule = {
  id: 'nene-inbox', actor: '', human: false, paths: ['file.**'], sceneFromPath: true,
  prefixes: [], phrases: [], senders: [], chatTypes: [],
  rule: 'msp-local', worktree: 'scene', payloadScope: true, otherwise: 'card' as const,
}

/** 一条 `file.created` 机器信号：actor 空、human false、payload 只有 name/path/bytes。 */
const signal = (file: string) => ({
  id: 'trigger-1', source: 'msp', human: false, at: new Date().toISOString(), text: '',
  threads: [{ source: 'msp', id: 'file.created' }],
  actor: { source: 'msp', id: '' },
  meta: { mspPath: 'file.created', mspPayload: { name: file.split(/[\\/]/).pop(), path: file, bytes: 12 } },
})

describe('matchesPath —— 和 Source 同一套 glob 语义', () => {
  it('file.** 覆盖 file.created 与更深层', () => {
    expect(matchesPath('file.**', 'file.created')).toBe(true)
    expect(matchesPath('file.**', 'file')).toBe(true)
    expect(matchesPath('file.**', 'file.a.b')).toBe(true)
  })
  it('不粘连前缀，不误伤别的路径', () => {
    expect(matchesPath('file.**', 'filewalk.created')).toBe(false)
    expect(matchesPath('file.**', 'notify.message')).toBe(false)
  })
  it('file.* 只多一段', () => {
    expect(matchesPath('file.*', 'file.created')).toBe(true)
    expect(matchesPath('file.*', 'file.a.b')).toBe(false)
  })
})

describe('sceneFromForTest —— 从路径推场景', () => {
  it('推得出场景 id 和目录', () => {
    const scene = sceneFromForTest(signal(join(qqDir, 'inbox', '0001-a.md')))
    expect(scene?.id).toBe('qq')
    expect(scene?.dir.replaceAll('\\', '/')).toContain('/3-scenes/qq')
  })
  it('两个不同场景各自推对', () => {
    expect(sceneFromForTest(signal(join(qqDir, 'inbox', 'a.md')))?.id).toBe('qq')
    expect(sceneFromForTest(signal(join(tokenDir, 'inbox', 'b.md')))?.id).toBe('token')
  })
  it('★ 路径里没有 /3-scenes/ → 推不出（退回前缀兜底，不是报错）', () => {
    expect(sceneFromForTest(signal(join(root, 'Downloads', 'Report.pdf')))).toBeUndefined()
  })
  it('★ 目录不存在 → 推不出（不开一张指向不存在目录的票）', () => {
    const ghost = join(root, '3-scenes', 'ghost', 'inbox', 'x.md')
    expect(sceneFromForTest(signal(ghost))).toBeUndefined()
  })
})

describe('resolveForTest —— 场景进 payload，交给既有的 sceneDirectory', () => {
  it('★ 命中 → how=scene，payload.scene={id,dir}', () => {
    const r = resolveForTest(signal(join(qqDir, 'inbox', '0001-a.md')), rule)
    expect(r?.how).toBe('scene')
    expect(r?.detail).toBe('qq')
    const scene = r?.payload.scene as { id: string; dir: string } | undefined
    expect(scene?.id).toBe('qq')
    expect(scene?.dir.replaceAll('\\', '/')).toContain('/3-scenes/qq')
  })
  it('★ title 用文件名兜底（watcher 的 payload 没有 title）', () => {
    const r = resolveForTest(signal(join(qqDir, 'inbox', '0007-my-letter.md')), rule)
    expect(r?.title).toBe('0007-my-letter.md')
  })
  it('★ 路径不含场景 → undefined（不抢这条信号）', () => {
    expect(resolveForTest(signal(join(root, 'Downloads', 'a.pdf')), rule)).toBeUndefined()
  })
  it('★ 路径不在 file.** 里 → undefined', () => {
    const other = { ...signal(join(qqDir, 'inbox', 'a.md')), meta: { mspPath: 'notify.message', mspPayload: { name: 'a.md', path: join(qqDir, 'inbox', 'a.md') } } }
    expect(resolveForTest(other, rule)).toBeUndefined()
  })
})

// ★ 2026-11-09 补：上面 11 条都是**手工构造规则对象**，绕过了 zod schema。
//   真跑的时候规则是从 auto-route.json 经 AutoRouteConfigSchema 解析出来的 ——
//   如果 schema 把 paths / sceneFromPath 吃掉（或 .strict() 拒绝它们），
//   上面那 11 条全绿也没用。这一组走**真的 loadAutoRoute**。
describe('schema 往返 —— 规则是从 JSON 解析出来的，不是手写的对象', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scene-from-path-config-'))
  const file = join(dir, 'auto-route.json')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('★ paths / sceneFromPath / actor:"" / human:false 能活着穿过 schema', () => {
    writeFileSync(file, JSON.stringify({
      enabled: true, source: 'msp', sender: 'seat', humanOnly: false,
      rules: [{ id: 'nene-inbox', paths: ['file.**'], sceneFromPath: true, actor: '', human: false, rule: 'msp-local' }],
    }))
    const config = loadAutoRoute(dir)
    const rule = config?.rules[0]
    expect(rule?.paths).toEqual(['file.**'])
    expect(rule?.sceneFromPath).toBe(true)
    expect(rule?.actor).toBe('')
    expect(rule?.human).toBe(false)
  })

  it('★ 只有 paths、没有 prefix 也没有 phrase —— 必须被接受（放宽后的 refine）', () => {
    writeFileSync(file, JSON.stringify({
      enabled: true, rules: [{ id: 'only-paths', paths: ['file.**'], rule: 'msp-local' }],
    }))
    expect(loadAutoRoute(dir)?.rules[0]?.id).toBe('only-paths')
  })

  it('★ 三样都没有的规则 —— 必须被拒（规则说不清替谁说话）', () => {
    writeFileSync(file, JSON.stringify({ enabled: true, rules: [{ id: 'says-nothing', rule: 'msp-local' }] }))
    expect(loadAutoRoute(dir)).toBeUndefined()
  })

  it('★ 解析出来的规则真的能派场景（端到端到 resolveTrigger）', () => {
    writeFileSync(file, JSON.stringify({
      enabled: true, humanOnly: false,
      rules: [{ id: 'nene-inbox', paths: ['file.**'], sceneFromPath: true, actor: '', human: false, rule: 'msp-local' }],
    }))
    const parsed = loadAutoRoute(dir)!.rules[0]!
    const r = resolveForTest(signal(join(qqDir, 'inbox', '0001-a.md')), parsed)
    expect(r?.how).toBe('scene')
    expect(r?.detail).toBe('qq')
  })
})

// ★ 0021 二：反推失败**不许静默**，必须留下能查的一句话。
//   今天已经吃过一次「静默丢」的亏 —— 信来了没开票，谁都查不出来。
describe('反推失败要留话（不许静默）', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'scene-miss-'))
  const file2 = join(dir2, 'auto-route.json')
  afterAll(() => rmSync(dir2, { recursive: true, force: true }))

  it('★ 路径推不出场景 → 那句话里带得上信号路径和 payload.path', () => {
    writeFileSync(file2, JSON.stringify({
      enabled: true, humanOnly: false,
      rules: [{ id: 'nene-inbox', paths: ['file.**'], sceneFromPath: true, actor: '', human: false, rule: 'msp-local' }],
    }))
    const rule2 = loadAutoRoute(dir2)!.rules[0]!
    const missed: string[] = []
    const outside = signal(join(root, 'Downloads', 'Report.pdf'))
    const r = autoRouteAssessment(
      { triggers: [outside] } as never,
      { policy: { rules: [{ id: 'msp-local', enabled: true }] } } as never,
      { enabled: true, source: 'msp', sender: 'seat', humanOnly: false, rules: [rule2] },
      (m) => missed.push(m),
    )
    expect(r).toBeUndefined()                       // 仍然兜底，不自己开票
    expect(missed.length).toBe(1)                   // 但要说话
    expect(missed[0]).toContain('file.created')     // 带信号路径
    expect(missed[0]).toContain('Report.pdf')       // 带 payload.path
  })
})
