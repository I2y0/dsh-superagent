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
import { readdirSync, statSync, watch as watchDirectory } from 'node:fs'
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
  /**
   * Only these extensions count; empty counts every file. Compared case-insensitively, without the dot.
   *
   * Accepts a list or one comma-separated cell: the panel's `rows` form gives a text cell a plain string, so a schema
   * that insisted on an array made the form unsaveable — an empty cell arrived as `''` and was refused.
   */
  extensions: z.union([z.string(), z.array(z.string())]).default('')
    .transform(value => (Array.isArray(value) ? value : String(value).split(','))
      .map(item => item.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)),
  /** Whether files inside subdirectories count too. Off by default: a mailbox is a flat directory. */
  recursive: z.boolean().default(false),
  /**
   * Whether a file here stands for something a person asked for.
   *
   * A dispatch a person sends has to stay `explicit`: it is routed without an assessment, and it may start work under a
   * rule that only admits explicit requests. A file event is `inferred` by nature — no sender, nothing addressed — so a
   * directory that carries a person's own request has to say so.
   */
  // Accepts what the panel actually sends. A `rows` text cell gives a string, so `human` arrives as "false" and a
  // schema that insisted on a boolean made the whole save fail for every row but a stored one (2026-11-09).
  human: z.union([z.boolean(), z.string()]).default(false)
    .transform(value => (typeof value === 'boolean' ? value
      : /^(1|true|yes|y|on|是)$/i.test(String(value).trim()))),
  /**
   * The account a `human` directory speaks for; it must be on the Source's allowed list.
   *
   * An empty cell is the normal case (the directory is not `human`), and the form sends `''` rather than omitting it,
   * so this takes anything and normalises to `undefined`. Same trap as `human` one commit back: every optional field
   * here has to accept what a text cell sends, or one empty cell rejects the whole save.
   */
  actor: z.string().optional().transform(value => (value ?? '').trim() || 'seat'),
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
      // `optional`: an empty cell means every file counts. Without it the form refuses to save an empty one, which made
      // the panel unusable for the only case this kind needs first (watch everything in a mailbox).
      { key: 'extensions', label: { zh: '只收这些扩展名（空=全部）', en: 'Extensions' }, type: 'text', optional: true },
      { key: 'human', label: { zh: '这个目录算人提的要求（1/0）', en: 'A file here is a request from a person (1/0)' }, type: 'text', optional: true },
      // 留空就是 `seat`：这个部署里「人」的那个节点就叫 seat，派活也一直用它。
      { key: 'actor', label: { zh: '算谁的账号（空=seat）', en: 'Account (empty = seat)' }, type: 'text', optional: true },
    ] },
    { key: 'settleMs', label: { zh: '文件稳定多久才认 / 毫秒', en: 'Settle time / ms' }, type: 'number', advanced: true, min: 100, max: 60_000 },
  ],
  health: [SOURCE],
  /**
   * The Policy's part on this Source.
   *
   * Declared rather than omitted because the panel lists a Source under "On each Source" only when it has one
   * (`client/eval.tsx`: `sources.filter(source => source.policy)`), so without it an operator cannot set this Source's
   * admission row at all — and an unset row falls back to `ignore`, which admits a file and then opens nothing.
   *
   * The `ambient` row has one applicable cell: a file has no sender and there is no membership list, so neither
   * "on the list" nor "addressed" can apply.
   */
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能通过这个来源发起工作的账号', en: 'Accounts that may originate work through this Source' },
      hint: { zh: '目录里的文件没有发送者，所以这个名单不会挡住它们；它只对带发送者的信号有意义。', en: 'A file has no sender, so this list never blocks one; it only matters for signals that carry a sender.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] }],
    explicit: { zh: '名单里的账号发的、点名智能体本人的信号。文件事件做不到这一点。', en: 'A signal from an account on the list that addresses the agent itself; a file event never can.' },
    rows: () => [{
      id: 'ambient' as const,
      label: { zh: '目录里的新文件', en: 'A new file in a directory' },
      note: { zh: '没有发送者', en: 'No sender' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true },
    }],
  },
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

export function apply(ctx: Context): void {
  // Register the kind itself. Without this the plugin loads, watches nothing and reports nothing: the panel lists the
  // Source as `missing` and every file in the mailboxes is dropped in silence. 2026-11-09 it was lost for two hours
  // because the temporary load marker wrapped this very call (`mark('register'); return …register(…)`) and removing the
  // marker removed the registration with it. Pinned by `tests/nene-inbox-apply.spec.ts`.
  ctx.effect(() => ctx.orchestrator.sources.register(neneInboxKind), 'nene-inbox: source kind')
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
    // A human directory speaks for its configured account and is addressed to the agent, exactly as the seat's own
    // dispatch is; every other directory is a sender-less machine event that can only ever be inferred.
    actor: { source: SOURCE, id: watched.human ? (watched.actor ?? '') : '' },
    human: watched.human,
    addressed: watched.human ? 'direct' as const : undefined,
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
  await ctx.ready
  if (signal.aborted) return

  /** Reads the configuration as the registry holds it now. */
  const readConfig = (): NeneInboxConfig | undefined => ctx.config<NeneInboxConfig>(SOURCE)

  /** How long a file's size must stay put before it counts; refreshed from Settings by `sync` below. */
  let settleMs = 1500
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
      }, settleMs)
      timers.add(timer)
    }
  }

  /**
   * Marks the files already in a directory as taken, so a start does not re-open what it already handled, and returns
   * the closers for that directory's watcher.
   */
  const open = (watched: Watched): (() => void)[] => {
    const opened: (() => void)[] = []
    let names: string[] = []
    try { names = readdirSync(watched.path, { recursive: watched.recursive, encoding: 'utf8' }) as string[] } catch {
      ctx.report(SOURCE, { state: 'error', detail: `${watched.role}: 目录读不了 ${watched.path}` })
      return opened
    }
    for (const name of names) state.set(join(watched.path, String(name)), 'taken')
    try {
      const watcher = watchDirectory(watched.path, { recursive: watched.recursive }, () => scan(watched))
      opened.push(() => { try { watcher.close() } catch { /* already gone */ } })
    } catch {
      ctx.report(SOURCE, { state: 'error', detail: `${watched.role}: 无法监控 ${watched.path}` })
    }
    return opened
  }

  /** Open watchers for the configuration in force; rebuilt when the configuration changes. */
  let open_ = new Map<string, (() => void)[]>()

  /**
   * Applies the configuration as it is now.
   *
   * The panel writes a Source's configuration into Settings, and this loop re-reads it instead of capturing it once:
   * otherwise a change needs a restart, which is exactly what went wrong when the first mailbox was saved and the
   * watcher kept reporting "no dirs".
   */
  const sync = (): NeneInboxConfig | undefined => {
    const config = readConfig()
    settleMs = config?.settleMs ?? 1500
    const next = new Map((config?.dirs ?? []).map(dir => [JSON.stringify(dir), dir]))
    for (const [key, closers_] of open_) {
      if (next.has(key)) continue
      for (const close of closers_) close()
      open_.delete(key)
    }
    for (const [key, watched] of next) {
      if (open_.has(key)) continue
      open_.set(key, open(watched))
    }
    return config
  }

  const first = sync()
  if (!first || first.dirs.length === 0) {
    ctx.report(SOURCE, { state: 'paused', detail: '还没有配置目录（面板 → Sources 里加）' })
  } else {
    ctx.report(SOURCE, { state: 'ready', detail: `监听 ${first.dirs.length} 个目录` })
  }

  // One sweep a second does three jobs: re-read the configuration, cover the events `fs.watch` misses (network drives,
  // editors that write elsewhere then rename), and settle files whose size stopped changing.
  const sweep = setInterval(() => {
    const config = sync()
    for (const watched of config?.dirs ?? []) scan(watched)
  }, 1000)

  await new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  clearInterval(sweep)
  for (const closers_ of open_.values()) for (const close of closers_) close()
  open_ = new Map()
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
}
