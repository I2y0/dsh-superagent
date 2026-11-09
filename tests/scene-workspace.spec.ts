import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DshExecutor, sceneDirectory, ticketExecution } from '../src/executor/dsh.ts'
import type { ExecutorHost } from '../src/executor/dsh.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'

let root: string
let scene: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scene-workspace-'))
  // The scene directory a seat dispatch names, as an inbox letter resolves it.
  scene = join(root, '3-scenes', 'qq')
  mkdirSync(scene, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/**
 * The Trigger a seat dispatch arrives as: a person-authored signal on `human.message` carrying the scene it resolved.
 *
 * Built here instead of imported: the msp Source was deleted 2026-11-09, but `sceneDirectory` and the Executor still read
 * the same `meta` keys (`mspPath` / `mspPayload`), so this test keeps its subject and drops only its dependency.
 */
const triggerOf = (path: string, payload: unknown): Trigger => ({
  id: `test:${path}:${JSON.stringify(payload ?? null).slice(0, 40)}`,
  source: 'msp',
  threads: [{ source: 'msp', id: 'human.message' }],
  actor: { source: 'msp', id: 'seat' },
  human: true,
  addressed: 'direct',
  at: '2026-11-04T06:47:54.612Z',
  text: `${path}\n${JSON.stringify(payload ?? {}).slice(0, 2000)}`,
  meta: { mspPath: path, mspNode: 'seat', mspPayload: payload },
})
const signal = (payload: unknown): Trigger => triggerOf('human.message', payload)

function ticketOf(trigger: Trigger, id = '33f72e72d5ebe0d28d6948900b853fcd'): Ticket {
  return {
    id, title: '让派活的工作目录=场景目录', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v3', basis: { via: 'addressed', addressed: 'direct' }, actor: { source: 'msp', id: 'seat' }, scope: 'scope' },
    channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: '2026-11-04T06:48:00.000Z', updatedAt: '2026-11-04T06:48:00.000Z',
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
  }
}
const accept = { kind: 'accept', title: 't', scope: 'scope', reason: 'explicitRouted', name: 'scene-as-cwd' } as const
const settings = SettingsSchema.parse({})

describe('the scene directory of a dispatch', () => {
  it('is the existing absolute directory the payload names', () => {
    expect(sceneDirectory(signal({ title: 'x', scene: { id: 'qq', dir: scene, memory: join(scene, 'memory.md') } }))).toBe(scene)
  })
  // ★ 2026-11-09（0022 Q2 的回归）：执行时读的是**存储里的** trigger，
  //   所以场景必须能从信号自己的路径推出来 —— 光在 assessment 里造一个 payload 没用，
  //   `prepare` 拿的是 `sourceTrigger()` 读回的那一份。这条就是那次事故的钉子。
  it('★ is derived from the signal path when the payload carries no scene', () => {
    expect(sceneDirectory(signal({ path: join(scene, 'inbox', '0001-a.md') }))).toBe(scene)
  })
  it('★ derives it from a Windows-style path too', () => {
    const win = scene.split('/').join(String.fromCharCode(92)) + String.fromCharCode(92) + 'inbox' + String.fromCharCode(92) + 'a.md'
    expect(sceneDirectory(signal({ path: win }))).toBe(scene)
  })
  it('★ a path outside the layout, or a directory that is not there, derives nothing', () => {
    expect(sceneDirectory(signal({ path: join(root, 'Downloads', 'Report.pdf') }))).toBeUndefined()
    expect(sceneDirectory(signal({ path: join(root, '3-scenes', 'ghost', 'inbox', 'x.md') }))).toBeUndefined()
  })
  it('★ an explicit scene.dir still wins over the path', () => {
    const other = join(root, '3-scenes', 'token')
    mkdirSync(other, { recursive: true })
    expect(sceneDirectory(signal({ scene: { dir: other }, path: join(scene, 'inbox', 'a.md') }))).toBe(other)
  })
  it('is ignored when the payload carries no scene, or no directory in it', () => {
    expect(sceneDirectory(signal({ title: 'x' }))).toBeUndefined()
    expect(sceneDirectory(signal({ scene: 'qq' }))).toBeUndefined()
    expect(sceneDirectory(signal({ scene: { id: 'qq' } }))).toBeUndefined()
    expect(sceneDirectory(signal({ scene: { dir: '' } }))).toBeUndefined()
    expect(sceneDirectory(signal({ scene: { dir: 42 } }))).toBeUndefined()
  })
  it('falls back to the ticket directory for a relative or missing directory, so a stale payload cannot move a launch', () => {
    expect(sceneDirectory(signal({ scene: { dir: '3-scenes/qq' } }))).toBeUndefined()
    expect(sceneDirectory(signal({ scene: { dir: join(root, '3-scenes', 'gone') } }))).toBeUndefined()
  })
  it('is not a scene for a path that is a file, which no worker can start in', () => {
    const file = join(root, '3-scenes', 'qq.md')
    writeFileSync(file, '# not a directory\n')
    expect(sceneDirectory(signal({ scene: { dir: file } }))).toBeUndefined()
  })
  it('is not a scene for a trigger of another source, or none at all', () => {
    expect(sceneDirectory(undefined)).toBeUndefined()
  })
})

describe('a ticket execution', () => {
  it('works in the scene directory, keeping its short name as the ticket name', () => {
    const trigger = signal({ scene: { id: 'qq', dir: scene } })
    const ticket = ticketOf(trigger)
    const execution = ticketExecution(ticket, accept, settings, root, sceneDirectory(trigger))
    expect(execution.directory).toBe(scene)
    expect(execution.name).toBe('scene-as-cwd-33f72e72d5eb')
  })
  it('keeps its own directory under the execution root when no scene applies', () => {
    const trigger = signal({ title: 'no scene here' })
    const execution = ticketExecution(ticketOf(trigger), accept, settings, root, sceneDirectory(trigger))
    expect(execution.directory).toBe(join(root, 'work', 'scene-as-cwd-33f72e72d5eb'))
  })
})

describe('the executor accepting a dispatch', () => {
  const executorFor = (trigger: Trigger | undefined, stateDir = root): DshExecutor => {
    const host = {
      store: { triggers: { get: (id: string) => trigger && trigger.id === id ? trigger : undefined }, settings: () => settings },
      machine: { stateDir },
      // The constructor only registers its effect handlers; preparing a ticket touches neither.
      effects: { handle: () => {} },
    }
    return new DshExecutor(host as unknown as ExecutorHost)
  }
  it('points the ticket at the scene its trigger named', () => {
    const trigger = signal({ title: '让派活的工作目录=场景目录', scene: { id: 'qq', dir: scene } })
    const prepared = executorFor(trigger).prepare(ticketOf(trigger), accept)
    expect(prepared.execution!.directory).toBe(scene)
  })
  it('points it at the default work directory when the trigger names no scene', () => {
    const trigger = signal({ title: 'plain dispatch' })
    const prepared = executorFor(trigger).prepare(ticketOf(trigger), accept)
    expect(prepared.execution!.directory).toBe(join(root, 'work', 'scene-as-cwd-33f72e72d5eb'))
  })
  it('uses the default directory when the origin trigger is gone', () => {
    const prepared = executorFor(undefined).prepare(ticketOf(signal({})), accept)
    expect(prepared.execution!.directory).toBe(join(root, 'work', 'scene-as-cwd-33f72e72d5eb'))
  })
})
