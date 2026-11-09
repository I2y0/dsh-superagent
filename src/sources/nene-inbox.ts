/**
 * nene inbox Source: a new file in a watched directory becomes a Trigger.
 *
 * Two things this kind replaces at once:
 *
 *  * `plugins/msp-filewatch`, which published `file.created` onto the local MSP mesh for the `msp` Source to pick up.
 *    That worked, but it made every mailbox depend on a third-party protocol implementation and on a single Thread per
 *    signal path, so a later letter was delivered into an earlier letter's ticket instead of opening its own.
 *  * Any per-mailbox adapter: the directories and what each one *means* live in configuration (`dirs[].role`), so a new
 *    kind of mailbox is a config line and a routing rule, not code.
 *
 * What this kind deliberately does not do is decide anything. It reads directories, builds a Trigger naming its role in
 * the signal path (`file.created.<role>`), and hands it to `receive()`. Who opens a ticket, who is merely told, and who
 * is ignored is the auto-route rule's business — a Source cannot prompt a Session, and should not try.
 */
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, readdirSync, statSync, watch as watchDirectory } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { type SourceContext, sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import type { Trigger } from '../core/index.ts'

export const SOURCE = 'nene-inbox'

/** One watched directory, and what a file appearing in it means. */
const WatchedSchema = z.object({
  /** Absolute directory. Its direct children are watched; subdirectories only when `recursive` says so. */
  path: z.string().trim().min(1),
  /** The mailbox's name, appended to the signal path (`file.created.<role>`), which routing rules match on. */
  role: z.string().trim().regex(/^[a-z][a-z0-9-]*$/),
  /** Only these extensions count; empty counts every file. Compared case-insensitively, without the dot. */
  extensions: z.array(z.string().trim().min(1)).default([]),
  /** Whether files inside subdirectories count too. Off by default: a mailbox is a flat directory. */
  recursive: z.boolean().default(false),
}).strict()

export const NeneInboxConfigSchema = z.object({
  /**
   * Watched directories. Empty receives nothing: a fresh install must not react to any file on the machine.
   *
   * This lives in **Settings → Sources**, not in the `config:` block of the plugin entry: a Source is configured by the
   * registry from `settings.sources[kind].config`, and falls back to these defaults when nothing is stored
   * (`sources/registry.ts` `resolve`). An insert's `config` never reaches `ctx.config()`.
   */
  dirs: z.array(WatchedSchema).default([]),
  /** A file must keep the same size this long before it counts, so a half-written file is not read as a message. */
  settleMs: z.number().int().min(100).max(60_000).default(1500),
}).strict()

export type Watched = z.infer<typeof WatchedSchema>
export type NeneInboxConfig = z.infer<typeof NeneInboxConfigSchema>

/**
 * The signal path a file from `role` arrives on.
 *
 * The role is part of the path so that routing rules can tell mailboxes apart with `paths` alone: the rule layer matches
 * signal paths, never filesystem paths, and `file.**` still matches every role for rules that want them all.
 */
export const signalPathOf = (role: string): string => `file.created.${role}`

/**
 * The Thread one file belongs to.
 *
 * One Thread per file, not per role: a Thread that already has a Ticket delivers later signals into that Ticket as
 * context instead of opening new work, so a shared Thread would make every letter after the first a follow-up of it.
 */
export const threadOf = (role: string, name: string): string => `inbox.${role}.${name}`

export const neneInboxKind: SourceKind<NeneInboxConfig> = {
  kind: SOURCE,
  title: { zh: 'nene 信箱', en: 'nene mailbox' },
  description: {
    zh: '把配置里每个目录的新文件变成一条工单信号。每个目录算哪类信箱由配置决定。',
    en: 'Turns a new file in each configured directory into a ticket signal. The configuration says what each directory means.',
  },
  schema: NeneInboxConfigSchema,
  fields: [
    { key: 'dirs', label: { zh: '监控的目录', en: 'Watched directories' }, type: 'rows', columns: [
      { key: 'path', label: { zh: '目录', en: 'Directory' }, type: 'text' },
      { key: 'role', label: { zh: '算哪类信箱', en: 'Role' }, type: 'text', pattern: '[a-z][a-z0-9-]*' },
      { key: 'extensions', label: { zh: '只收这些扩展名（空=全部）', en: 'Extensions' }, type: 'text' },
    ] },
    { key: 'settleMs', label: { zh: '文件稳定多久才认 / 毫秒', en: 'Settle time / ms' }, type: 'number', advanced: true, min: 100, max: 60_000 },
  ],
  health: [SOURCE],
  /**
   * Every file this kind reports is in scope and observed: there is no membership list to filter by, exactly as the msp
   * Source argues for its own signals. `row` names the admission row the Policy looks up, so
   * `policy.sources.nene-inbox.admission.ambient.unlistedUnaddressed` must be `inferred`; otherwise a file arrives and
   * no ticket is ever opened, with nothing reported anywhere.
   */
  scope: () => ({ listened: true, observed: true, row: 'ambient' }),
}

export const name = 'dsh-superagent-nene-inbox'
export const inject = ['orchestrator']

/**
 * Writes one line where a person can find it when the plugin loads.
 *
 * This host keeps no persistent log, so a plugin that fails to load leaves nothing behind — which cost two restarts on
 * 2026-11-09 while `apply()` was fine all along. The marker says whether this ran at all, and it goes away with the
 * Temporary: it writes always, and it is removed once the plugin is confirmed to load.
 */
function mark(step: string, detail = ''): void {
  const file = process.env.NENE_INBOX_MARK
    ?? join(homedir(), '.dsh', 'state', 'superagent', 'nene-inbox-apply.log')
  try { appendFileSync(file, `${new Date().toISOString()}	${step}	${detail}
`) } catch { /* diagnostics must not fail the plugin */ }
}

export function apply(ctx: Context): void {
  mark('apply', `inject=${JSON.stringify(inject)}`)
  ctx.effect(() => { mark('register'); return ctx.orchestrator.sources.register(neneInboxKind) }, 'nene-inbox: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, neneInboxKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/**
 * One file as a Trigger.
 *
 * `meta.mspPath` and `meta.mspPayload` keep the names the routing rules and the Executor already read, so nothing
 * downstream changes while the transport does: the rule matches `file.created.<role>` and `sceneDirectory` finds the
 * scene from `payload.path`. The keys are renamed once the msp Source is gone.
 */
export function buildTrigger(watched: Watched, name: string, absolutePath: string, bytes: number, at: string): Trigger {
  const payload = { name, path: absolutePath, bytes }
  return {
    id: `${SOURCE}:${watched.role}:${name}`,
    source: SOURCE,
    threads: [{ source: SOURCE, id: threadOf(watched.role, name) }],
    // A machine event has no sender: an empty id keeps it from ever standing in for a person's request.
    actor: { source: SOURCE, id: '' },
    human: false,
    at,
    text: `${absolutePath}
${JSON.stringify(payload)}`,
    meta: { mspPath: signalPathOf(watched.role), mspPayload: payload },
  }
}

/** Whether `name` is a file this entry wants: plain files only, matching one of `extensions` when any are given. */
export function wanted(watched: Watched, name: string): boolean {
  if (name.startsWith('.')) return false
  if (watched.extensions.length === 0) return true
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return watched.extensions.some(entry => entry.replace(/^\./, '').toLowerCase() === extension)
}

/** A file whose size stopped changing; `bytes` and `at` describe it as it was accepted. */
interface Settled { name: string; path: string; bytes: number; at: string }

/**
 * Watches the configured directories and reports each file it settles on.
 *
 * Every accepted file becomes a Trigger and is ingested with `receive()`, which is where this Source's responsibility
 * ends: routing, tickets and workers all belong to the host.
 */
export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  mark('watch-start')
  await ctx.ready
  if (signal.aborted) return
  const config = ctx.config<NeneInboxConfig>(SOURCE)
  if (!config || config.dirs.length === 0) {
    mark('watch-paused', 'no dirs')
    ctx.report(SOURCE, { state: 'paused', detail: '没有配置目录，什么都不收' })
    return
  }

  /** Absolute path → the last size seen, or a marker for the two states that need no more scanning. */
  const state = new Map<string, number | 'settling' | 'taken'>()
  const timers = new Set<NodeJS.Timeout>()
  const closers: (() => void)[] = []
  let seen = 0

  const accept = (watched: Watched, settled: Settled): void => {
    const trigger = buildTrigger(watched, settled.name, settled.path, settled.bytes, settled.at)
    seen += 1
    // Reported before `receive()`: if ingesting throws, the panel still shows which file caused it.
    ctx.report(SOURCE, {
      state: 'ready',
      detail: `${watched.role}: ${settled.name} ${settled.bytes}B → ${trigger.meta.mspPath}`
        + `（线程 ${trigger.threads[0]?.id}）· 已交 ${seen} 个`,
    })
    Promise.resolve(ctx.receive(trigger)).catch((error: unknown) => {
      ctx.report(SOURCE, {
        state: 'error',
        detail: `${watched.role}: ${settled.name} 交不进 Engine：${error instanceof Error ? error.message : String(error)}`,
      })
    })
  }

  const scan = (watched: Watched): void => {
    let names: string[]
    try { names = readdirSync(watched.path) } catch { return }
    for (const name of names) {
      if (!wanted(watched, name)) continue
      const absolutePath = join(watched.path, name)
      let size: number
      try {
        const stat = statSync(absolutePath)
        // A subdirectory is skipped unless this entry recurses; `readdirSync` above already flattens when it does not.
        if (!stat.isFile()) continue
        size = stat.size
      } catch { continue }
      const before = state.get(absolutePath)
      if (before === 'taken' || before === 'settling') continue
      // First sight records the size: a file that existed before startup is never treated as new.
      if (before === undefined || before !== size) { state.set(absolutePath, size); continue }
      state.set(absolutePath, 'settling')
      const timer = setTimeout(() => {
        timers.delete(timer)
        try {
          const now = statSync(absolutePath)
          if (now.size !== size) { state.set(absolutePath, now.size); return }
          state.set(absolutePath, 'taken')
          accept(watched, { name, path: absolutePath, bytes: size, at: now.mtime.toISOString() })
        } catch { state.set(absolutePath, 'taken') }
      }, config.settleMs)
      timers.add(timer)
    }
  }

  for (const watched of config.dirs) {
    let names: string[] = []
    try { names = readdirSync(watched.path, { recursive: watched.recursive, encoding: 'utf8' }) as string[] } catch {
      ctx.report(SOURCE, { state: 'error', detail: `${watched.role}: 目录读不了 ${watched.path}` })
      continue
    }
    // Files already there when the plugin starts are taken: a restart must not re-open what it already handled.
    for (const name of names) state.set(join(watched.path, String(name)), 'taken')
    try {
      const watcher = watchDirectory(watched.path, { recursive: watched.recursive }, () => scan(watched))
      closers.push(() => { try { watcher.close() } catch { /* already gone */ } })
    } catch {
      ctx.report(SOURCE, { state: 'error', detail: `${watched.role}: 无法监控 ${watched.path}` })
    }
    // `fs.watch` misses events (network drives, editors that write elsewhere then rename); a slow sweep covers it.
    const interval = setInterval(() => scan(watched), 1000)
    closers.push(() => clearInterval(interval))
  }

  mark('watch-ready', `dirs=${config.dirs.map(d => d.role).join(',')}`)
  ctx.report(SOURCE, { state: 'ready', detail: `监听 ${config.dirs.length} 个目录` })

  await new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  for (const close of closers) close()
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
}
