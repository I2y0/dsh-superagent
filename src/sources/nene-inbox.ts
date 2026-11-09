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
import { z } from 'zod'

import { type SourceContext, sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

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
  /** Watched directories. Empty receives nothing: a fresh install must not react to any file on the machine. */
  dirs: z.array(WatchedSchema).default([]),
  /** A file must keep the same size this long before it counts, so a half-written file is not read as a message. */
  settleMs: z.number().int().min(100).max(60_000).default(1500),
}).strict()

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

export function apply(ctx: Context): void {
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
 * Watches the configured directories.
 *
 * Every step of this plan adds one piece to this loop; it starts by reporting that it has nothing to do yet, so the
 * plugin can be registered and seen in the panel before it can open a single ticket.
 */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (signal.aborted) return
  const config = ctx.config<NeneInboxConfig>(SOURCE)
  if (!config || config.dirs.length === 0) {
    ctx.report(SOURCE, { state: 'paused', detail: '没有配置目录，什么都不收' })
    return
  }
  ctx.report(SOURCE, { state: 'ready', detail: `配置了 ${config.dirs.length} 个目录（监听尚未接上）` })
}
