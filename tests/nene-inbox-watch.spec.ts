// 监听循环本身：投一个文件进去，它必须变成一条 Trigger 交给 Engine —— 而且只交一次。
//
// 这一份用**真的文件系统**（临时目录）和一个假的 SourceContext。假 ctx 里故意没有叫醒会话的能力：
// receive() 是这个 Source 唯一能做事的地方，越界就会当场暴露。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'
import { SOURCE, watch } from '../src/sources/nene-inbox.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 一个只够这个 Source 用的假上下文：记下每一次 receive 与每一次 report。 */
function fakeContext(dirs: { path: string; role: string; extensions: string[]; recursive: boolean; human: boolean; actor: string }[], settleMs = 100) {
  const received: Trigger[] = []
  const reported: { state: string; detail: string }[] = []
  const ctx = {
    ready: Promise.resolve(),
    config: () => ({ dirs, settleMs }),
    receive: (trigger: Trigger) => { received.push(trigger) },
    report: (_entry: string, health: { state: string; detail: string }) => { reported.push({ state: health.state, detail: health.detail }) },
  }
  return { ctx: ctx as unknown as SourceContext, received, reported }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('监听循环', () => {
  it('★ 投一个文件 → 交给 Engine，role 进信号路径，正文第一行是绝对路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nene-inbox-watch-'))
    roots.push(root)
    const inbox = join(root, 'inbox')
    mkdirSync(inbox, { recursive: true })
    const { ctx, received } = fakeContext([{ path: inbox.replaceAll('\\', '/'), role: 'workshop', extensions: [], recursive: false, human: false, actor: 'seat' }])

    const controller = new AbortController()
    const running = watch(ctx, controller.signal)
    await sleep(150)                                    // 让它先扫一遍并登记既有文件
    const letter = join(inbox, '0001-a.md')
    writeFileSync(letter, '# 一封信\n', 'utf8')
    await sleep(1400)                                   // 稳定期 100ms + 一秒兜底扫描

    controller.abort()
    await running

    expect(received).toHaveLength(1)
    const trigger = received[0]!
    expect(trigger.source).toBe(SOURCE)
    expect(trigger.meta?.mspPath).toBe('file.created.workshop')
    expect(trigger.text.split('\n')[0]!.replaceAll('\\', '/')).toBe(letter.replaceAll('\\', '/'))
    expect(trigger.human).toBe(false)
  })

  it('★ 同一个文件只交一次（兜底扫描每秒都在跑）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nene-inbox-once-'))
    roots.push(root)
    const { ctx, received } = fakeContext([{ path: root.replaceAll('\\', '/'), role: 'qq', extensions: [], recursive: false, human: false, actor: 'seat' }])

    const controller = new AbortController()
    const running = watch(ctx, controller.signal)
    await sleep(150)
    writeFileSync(join(root, '0001-a.md'), 'x', 'utf8')
    await sleep(2600)                                   // 跨两次兜底扫描

    controller.abort()
    await running
    expect(received).toHaveLength(1)
  })

  it('★ 启动时已经存在的文件不交（重启不重开）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nene-inbox-existing-'))
    roots.push(root)
    writeFileSync(join(root, '0001-old.md'), 'old', 'utf8')
    const { ctx, received } = fakeContext([{ path: root.replaceAll('\\', '/'), role: 'qq', extensions: [], recursive: false, human: false, actor: 'seat' }])

    const controller = new AbortController()
    const running = watch(ctx, controller.signal)
    await sleep(1600)

    controller.abort()
    await running
    expect(received).toHaveLength(0)
  })

  it('★ 目录没配 → 状态是 paused，什么都不交', async () => {
    const { ctx, received, reported } = fakeContext([])
    const controller = new AbortController()
    const running = watch(ctx, controller.signal)
    await sleep(150)
    controller.abort()
    await running
    expect(received).toHaveLength(0)
    expect(reported.some(item => item.state === 'paused')).toBe(true)
  })
})

// ★ 配置改了不能要求重启：面板保存的是 Settings，watcher 每秒重读一次。
//   2026-11-09 就是这里卡住的 —— 配置存进去了，watcher 还报「no dirs」。
describe('配置热更新', () => {
  it('★ 一开始没目录 → 保存之后自己开始收，不用重启', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nene-inbox-hot-'))
    roots.push(root)
    const received: Trigger[] = []
    // 会变的配置：先空，1.2 秒后出现 workshop
    let dirs: { path: string; role: string; extensions: string[]; recursive: boolean; human: boolean; actor: string }[] = []
    const ctx = {
      ready: Promise.resolve(),
      config: () => ({ dirs, settleMs: 100 }),
      receive: (trigger: Trigger) => { received.push(trigger) },
      report: () => {},
    } as unknown as SourceContext

    const controller = new AbortController()
    const running = watch(ctx, controller.signal)
    await sleep(200)
    expect(received).toHaveLength(0)                 // 还没配

    dirs = [{ path: root.split(String.fromCharCode(92)).join('/'), role: 'workshop', extensions: [], recursive: false, human: false, actor: 'seat' }]
    await sleep(1400)                                // 让它重读到配置并开 watch
    writeFileSync(join(root, '0001-a.md'), 'x', 'utf8')
    await sleep(1600)

    controller.abort()
    await running
    expect(received).toHaveLength(1)
    expect(received[0]!.meta?.mspPath).toBe('file.created.workshop')
  })

  it('★ 目录被移出配置 → 不再收那个目录的文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nene-inbox-drop-'))
    roots.push(root)
    const received: Trigger[] = []
    let dirs = [{ path: root.split(String.fromCharCode(92)).join('/'), role: 'qq', extensions: [], recursive: false, human: false, actor: 'seat' }]
    const ctx = {
      ready: Promise.resolve(),
      config: () => ({ dirs, settleMs: 100 }),
      receive: (trigger: Trigger) => { received.push(trigger) },
      report: () => {},
    } as unknown as SourceContext

    const controller = new AbortController()
    const running = watch(ctx, controller.signal)
    await sleep(200)
    dirs = []
    await sleep(1300)                                // 让它关掉那个 watch
    writeFileSync(join(root, '0002-b.md'), 'x', 'utf8')
    await sleep(1600)

    controller.abort()
    await running
    expect(received).toHaveLength(0)
  })
})
