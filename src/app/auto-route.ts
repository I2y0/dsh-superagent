/**
 * Deterministic auto-route: decide a dispatch here instead of relaying a candidate card the main Session (the seat) would
 * only accept or ignore by hand.
 *
 * Two kinds of dispatch reach this deployment:
 *
 *  - The seat itself (`human.message` from MSP node `seat`) carries a title prefix such as `[QQ]`, `[查]`, `[扫]`.
 *  - A person's chat reaches MSP through a bridge. `nene-qq` publishes `work.nene.qq.message` with the message text in
 *    `payload.text`, the QQ number in `payload.sender` and `payload.chatType`; it is a machine signal (no actor, not
 *    `human`), because a bridge must never pretend a person addressed the agent (architecture §4.3).
 *
 * A phrase rule speaks for those bridged messages and opens a ticket only when the text itself hands the work over
 * (“让影子去做 X”, “派个 worker 干 Y”). Everything else it speaks for is decided without a ticket: the chat path that
 * published the signal already wakes the seat to answer there, so a second candidate card only buys a second model call.
 *
 * Why a JSON file instead of Policy settings: these are deployment-local routing facts (which dispatch phrases mean work),
 * not authorization rules. They change often, they must be editable without a restart, and they must not alter the Policy
 * version every open ticket's Mandate was accepted under. The file is read when an Eval starts, so an edit applies to the
 * next Trigger.
 *
 * Safety: nothing bypasses the existing gate. A match only builds the same `Assessment` the main Session would have written;
 * `assessmentOutcome` still validates the direction and rules, and `Evals.decide` still checks admissibility and accept mode.
 * A candidate that does not resolve to exactly one configured rule, or whose configured Policy rule is disabled, falls back
 * to the normal candidate card.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { Candidate } from '../core/index.ts'
import type { Assessment, Settings } from '../policy.ts'

/** What marks a Trigger as work this rule settles, who it speaks for, and how its ticket is named and scoped. */
const AutoRouteRuleSchema = z.object({
  /** Lowercase id, used in the Decision reason and the audit. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  /** Title prefixes that mark this kind of work, compared after trimming the title. */
  prefixes: z.array(z.string().trim().min(1)).default([]),
  /** Phrases in `payload.text` that hand work over (“让影子去”, “派个 worker”), compared case-insensitively. */
  phrases: z.array(z.string().trim().min(1).max(40)).default([]),
  /**
   * Signal paths this rule speaks for, as MSP globs (`file.**`). Empty speaks for any path.
   *
   * A local file watcher publishes `file.created` with no title and no phrase in it: the path is the only thing that
   * says what arrived. Filtering on it keeps this rule from claiming every machine signal the Source admits.
   */
  paths: z.array(z.string().trim().min(1)).default([]),
  /**
   * Derive the scene from the signal's own path instead of the payload (`/3-scenes/<id>/...` → `{id, dir}`).
   *
   * A watcher knows a file appeared, not which scene it belongs to; the path already carries that, and deriving it here
   * keeps the dispatcher from having to repeat the layout in every payload.
   */
  sceneFromPath: z.boolean().default(false),
  /** `payload.sender` values (QQ/Feishu ids) this rule speaks for; empty speaks for any sender. */
  senders: z.array(z.string().trim().min(1)).default([]),
  /** `payload.chatType` values (such as `private`) this rule speaks for; empty speaks for any chat. */
  chatTypes: z.array(z.string().trim().min(1)).default([]),
  /**
   * The Trigger's actor id this rule speaks for; `''` is a local bridge that speaks for a person, which MSP marks as a
   * senderless machine signal. Omitted uses the file's `sender`.
   */
  actor: z.string().trim().optional(),
  /** Whether the Trigger must be declared human; omitted uses the file's `humanOnly`. */
  human: z.boolean().optional(),
  /** Policy rule id recorded on the accepted Mandate; it must stay enabled. */
  rule: z.string().min(1),
  /** First segment of the ticket's worktree name; the dispatch task id follows it. */
  worktree: z.string().regex(/^[a-z][a-z0-9-]{0,15}$/).default('task'),
  /** Scope used when the payload names none, or when `payloadScope` is false. */
  scope: z.string().trim().min(1).max(1500).optional(),
  /** Whether the payload's own `scope` wins over this rule's (a seat dispatch names its own scope). */
  payloadScope: z.boolean().default(true),
  /**
   * What to do with a message this rule speaks for that carries no prefix and no phrase: `card` relays it to the seat as
   * usual, `ignore` decides it with no ticket and no card because the chat path that published it answers the person.
   */
  otherwise: z.enum(['card', 'ignore']).default('card'),
}).strict().refine(rule => rule.prefixes.length > 0 || rule.phrases.length > 0 || rule.paths.length > 0,
  'A rule needs at least one title prefix, one text phrase, or one signal path')
export const AutoRouteConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Source and, when set, the actor that may use auto-route; the seat's dispatches are `msp` from `seat`. */
  source: z.string().trim().min(1).default('msp'),
  sender: z.string().trim().min(1).default('seat'),
  /** Only a Trigger the Source declared human may auto-route, so machine noise cannot open tickets by title alone. */
  humanOnly: z.boolean().default(true),
  rules: z.array(AutoRouteRuleSchema).default([]),
}).strict()
export type AutoRouteConfig = z.infer<typeof AutoRouteConfigSchema>
export type AutoRouteRule = z.infer<typeof AutoRouteRuleSchema>

/** The file a deployment edits to change the rules; read on each Eval, so an edit needs no restart. */
export const autoRouteFile = (stateDir: string): string => join(stateDir, 'auto-route.json')

/**
 * A phrase followed by one of these turns into a statement about the past or a noun phrase, not a request: the seat's own
 * words “我让影子做的都转给它了” must not open a ticket.
 */
export const PHRASE_STATEMENT_FOLLOWERS = ['的', '过', '完'] as const
/** A phrase preceded by one of these is negated or deferred: “别让影子去”, “先不让 worker 接”. */
export const PHRASE_NEGATIONS = ['别', '不', '没'] as const

let cached: { file: string; mtimeMs: number; config: AutoRouteConfig } | undefined

/**
 * Read the deployment's auto-route rules.
 * @returns the parsed rules, or `undefined` when the file is missing or invalid. An invalid file turns auto-route off
 * rather than failing an Eval: the candidate card still reaches the main Session, so the work is not lost.
 */
export function loadAutoRoute(stateDir: string): AutoRouteConfig | undefined {
  const file = autoRouteFile(stateDir)
  try {
    const mtimeMs = statSync(file).mtimeMs
    if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.config
    const config = AutoRouteConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    cached = { file, mtimeMs, config }
    return config
  } catch {
    cached = undefined
    return undefined
  }
}

/** The payload a Source attached to a machine message: MSP Signals carry theirs under `mspPayload`. */
function payloadOf(trigger: Candidate['triggers'][number]): Record<string, unknown> | undefined {
  const payload = trigger.meta?.mspPayload
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined
}

/** A worktree-name segment for the dispatch: its task id when plain, else a short stable hash of the Trigger id. */
function taskSegment(payload: Record<string, unknown>, triggerId: string): string {
  const task = typeof payload.task === 'string' ? payload.task.trim().toLowerCase() : ''
  if (/^[a-z0-9]{2,20}$/.test(task)) return task
  // FNV-1a, base36: deterministic across restarts, and only the ticket directory's name depends on it.
  let hash = 0x811c9dc5
  for (const char of triggerId) {
    hash ^= char.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(4, '0').slice(0, 8)
}

/** Whether a rule speaks for this Trigger: right source, actor, human flag, and the payload's sender and chat type. */
function speaksFor(trigger: Candidate['triggers'][number], rule: AutoRouteRule, config: AutoRouteConfig): Record<string, unknown> | undefined {
  if (trigger.source !== config.source) return undefined
  if (trigger.actor.id !== (rule.actor ?? config.sender)) return undefined
  if ((rule.human ?? config.humanOnly) && trigger.human !== true) return undefined
  const payload = payloadOf(trigger)
  if (!payload) return undefined
  const sender = typeof payload.sender === 'string' ? payload.sender : ''
  const chatType = typeof payload.chatType === 'string' ? payload.chatType : ''
  if (rule.senders.length > 0 && !rule.senders.includes(sender)) return undefined
  if (rule.chatTypes.length > 0 && !rule.chatTypes.includes(chatType)) return undefined
  // A rule that names signal paths speaks only for those: a watcher publishes from a path that says what arrived, and a
  // phrase or title may be absent entirely.
  if (rule.paths.length > 0 && !rule.paths.some(pattern => matchesPath(pattern, signalPath(trigger)))) return undefined
  return payload
}

/** The signal path a Trigger arrived on (`file.created`, `work.nene.qq.message`), or `''` when it carried none. */
function signalPath(trigger: Candidate['triggers'][number]): string {
  const path = trigger.meta?.mspPath
  return typeof path === 'string' ? path : ''
}

/**
 * Whether an MSP signal-path glob matches a path, with the same semantics the Source uses: `**` is everything, `x.**`
 * is `x` and everything below it, `x.*` is exactly one more segment.
 *
 * Kept here rather than imported: this decides routing, and a routing rule must not change with the wire protocol.
 */
export function matchesPath(pattern: string, path: string): boolean {
  if (pattern === '**' || pattern === '*') return true
  if (pattern === path) return true
  if (pattern.endsWith('.**')) {
    const base = pattern.slice(0, -3)
    return path === base || path.startsWith(base + '.')
  }
  if (pattern.endsWith('.*')) {
    const base = pattern.slice(0, -2)
    const rest = path.startsWith(base + '.') ? path.slice(base.length + 1) : null
    return rest !== null && rest.length > 0 && !rest.includes('.')
  }
  return false
}

/**
 * The scene a signal's own path names: `.../3-scenes/<id>/...` → `{ id, dir }`.
 *
 * The directory must be absolute and must exist, by the same test the dispatcher's `payload.scene.dir` goes through
 * (see `sceneDirectory`): a stale or malformed path falls back to the ticket directory under the execution root rather
 * than failing the launch, and a ticket is never aimed at a directory that is not there.
 *
 * @returns the scene, or `undefined` when the path names none or the directory is missing
 */
const dirOf = (posixPath: string): string => {
  // The probe was normalised to `/`; Node accepts forward slashes on every platform this runs on.
  return posixPath.replace(/\/+$/, '')
}

function sceneFrom(trigger: Candidate['triggers'][number]): { id: string; dir: string } | undefined {
  const payload = payloadOf(trigger)
  const fromPayload = typeof payload?.path === 'string' ? payload.path : ''
  const probe = (fromPayload || signalPath(trigger)).split(String.fromCharCode(92)).join('/')
  const match = /(^|\/)3-scenes\/([A-Za-z0-9_-]+)(\/|$)/.exec(probe)
  if (!match) return undefined
  const id = match[2]!
  const end = probe.indexOf('/3-scenes/') + '/3-scenes/'.length + id.length
  const dir = dirOf(probe.slice(0, end))
  return isAbsolute(dir) && statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? { id, dir } : undefined
}

/**
 * The first configured phrase that hands work over, with the two guards that keep ordinary talk from opening tickets.
 * @returns the phrase as configured, or `undefined` when the text carries none.
 */
export function matchedPhrase(text: string, phrases: readonly string[]): string | undefined {
  const haystack = text.toLowerCase()
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase()
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      const before = haystack.slice(Math.max(0, at - 1), at)
      const after = haystack.slice(at + needle.length, at + needle.length + 1)
      if ((PHRASE_NEGATIONS as readonly string[]).includes(before)) continue
      if ((PHRASE_STATEMENT_FOLLOWERS as readonly string[]).includes(after)) continue
      return phrase
    }
  }
  return undefined
}

/** One Trigger's resolution: the rule that settles it, and whether that opens a ticket or only closes the message. */
interface Resolution { rule: AutoRouteRule; decision: 'accept' | 'silent'; how: 'prefix' | 'phrase' | 'scene'; detail: string; title: string; payload: Record<string, unknown> }

/** The rule that settles one Trigger, or `undefined` when it is the seat's to decide. */
function resolveTrigger(trigger: Candidate['triggers'][number], config: AutoRouteConfig,
  onMiss?: (message: string) => void): Resolution | undefined {
  if (!config.enabled || config.rules.length === 0) return undefined
  let silent: Resolution | undefined
  for (const rule of config.rules) {
    const payload = speaksFor(trigger, rule, config)
    if (!payload) continue
    // An explicit opt-out in the payload wins over every rule.
    if (payload.autoRoute === false) return undefined
    // A watcher's payload names a file, not a dispatch: fall back to it so a path-derived rule still has something to
    // name the ticket with.
    const named = typeof payload.name === 'string' ? payload.name.trim() : ''
    const title = (typeof payload.title === 'string' ? payload.title.trim() : '') || (rule.sceneFromPath ? named : '')
    if (!title) return undefined
    // A scene from the path is the hardest evidence there is: the layout itself says which scene the file belongs to, so
    // it wins over a prefix or a phrase someone wrote by hand.
    if (rule.sceneFromPath) {
      const scene = sceneFrom(trigger)
      if (scene) return { rule, decision: 'accept', how: 'scene', detail: scene.id, title, payload: { ...payload, scene } }
      // ★ 2026-11-09（0021 二）：反推失败**必须留下痕迹**，不许静默当没收到。
      //   照原样继续走 prefix/phrase 兜底，但要说一句，否则「信来了没开票」永远查不出来。
      onMiss?.(`auto-route ${rule.id}: 信号路径推不出场景（mspPath=${signalPath(trigger) || '无'}，`
        + `payload.path=${typeof payload.path === 'string' ? payload.path : '无'}），按前缀/短语兜底`)
    }
    const prefix = rule.prefixes.find(item => title.startsWith(item))
    if (prefix) return { rule, decision: 'accept', how: 'prefix', detail: prefix, title, payload }
    const text = typeof payload.text === 'string' ? payload.text : ''
    const phrase = matchedPhrase(text, rule.phrases)
    if (phrase) return { rule, decision: 'accept', how: 'phrase', detail: phrase, title, payload }
    // This rule owns the message and still found no work in it: it may say so, but a later rule may still find work.
    if (rule.otherwise === 'ignore') silent ??= { rule, decision: 'silent', how: 'phrase', detail: '', title, payload }
  }
  return silent
}

/** The scene a signal's path names, for a test to call directly (see `sceneFrom`). */
export const sceneFromForTest = (trigger: Candidate['triggers'][number]): { id: string; dir: string } | undefined => sceneFrom(trigger)

/** One Trigger resolved against a single rule, for a test to call directly (see `resolveTrigger`). */
export const resolveForTest = (trigger: Candidate['triggers'][number], rule: AutoRouteRule): Resolution | undefined =>
  resolveTrigger(trigger, { enabled: true, source: 'msp', sender: 'seat', humanOnly: false, rules: [rule] })

/** The resolution every Trigger of one Eval agrees on, or `undefined` when the seat should decide the batch. */
function resolveCandidate(candidate: Candidate, config: AutoRouteConfig,
  onMiss?: (message: string) => void): Resolution | undefined {
  if (!config.enabled || config.rules.length === 0) return undefined
  if (candidate.triggers.length === 0) return undefined
  let resolved: Resolution | undefined
  for (const trigger of candidate.triggers) {
    const item = resolveTrigger(trigger, config, onMiss)
    if (!item) return undefined
    // One Eval may hold a batch: all of it must be the same kind of dispatch, or the seat decides.
    if (resolved && (resolved.rule.id !== item.rule.id || resolved.decision !== item.decision || resolved.detail !== item.detail)) return undefined
    resolved ??= item
  }
  return resolved
}

/** What `autoRouteAssessment` decided for a candidate: the assessment to submit, and whether it opens a ticket. */
export interface AutoRouteChoice {
  /** `accept` opens a ticket; `silent` records an ignore so the seat is not woken for a message that answers itself. */
  decision: 'accept' | 'silent'
  /** The assessment the main Session would have written for this candidate. */
  assessment: Assessment
}

/**
 * Build the Assessment a candidate would have received from the main Session.
 * @returns the choice for `assessmentOutcome`, or `undefined` when the candidate is not configured work.
 */
export function autoRouteAssessment(candidate: Candidate, settings: Settings, config: AutoRouteConfig | undefined,
  onMiss?: (message: string) => void): AutoRouteChoice | undefined {
  if (!config) return undefined
  const resolution = resolveCandidate(candidate, config, onMiss)
  if (!resolution) return undefined
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  // A configured rule that an operator disabled must not keep deciding: the seat decides instead.
  if (!enabled.some(item => item.id === resolution.rule.rule)) return undefined
  const trigger = candidate.triggers[0]!
  const { rule, payload, title } = resolution
  const ruleAssessments = enabled.map(item => ({
    rule_id: item.id,
    matched: item.id === rule.rule,
    reason: item.id === rule.rule
      ? resolution.decision === 'accept'
        ? `Auto-route ${rule.id}: «${title}» carries ${resolution.how === 'prefix' ? 'the title prefix' : 'the dispatch phrase'} ${resolution.detail}`
        : `Auto-route ${rule.id}: «${title}» hands no work to a worker, so the chat path answers it`
      : `Auto-route ${rule.id} settled by rule ${rule.rule} instead`,
  }))
  if (resolution.decision === 'silent') {
    const scope = `No ticket: ${title}`
    return {
      decision: 'silent',
      assessment: {
        decision: 'ignore',
        rule_assessments: ruleAssessments,
        direction: {
          implementation_requested: false,
          target_basis: 'undetermined',
          requires_design_decision: false,
          evidence: `Auto-route ${rule.id}: the message names no work for a worker`,
        },
        title: title.slice(0, 160),
        scope: scope.slice(0, 1500),
        reason: `Auto-route ${rule.id}: no dispatch phrase, so no ticket and no candidate card`,
      },
    }
  }
  const ownScope = typeof payload.scope === 'string' && payload.scope.trim() ? payload.scope.trim() : undefined
  const scope = rule.payloadScope && ownScope ? ownScope : rule.scope ?? ownScope ?? `Only what the title names: ${title}`
  return {
    decision: 'accept',
    assessment: {
      decision: 'accept',
      rule_assessments: ruleAssessments,
      direction: {
        implementation_requested: true,
        target_basis: 'specified',
        requires_design_decision: false,
        evidence: `Auto-route ${rule.id}: the sender's own message «${title}» ${resolution.how === 'prefix'
          ? `carries the simple-work prefix ${resolution.detail}`
          : `hands the work over with the phrase ${resolution.detail}`}`,
      },
      title: title.slice(0, 160),
      worktree_name: `${rule.worktree}-${taskSegment(payload, trigger.id)}`.slice(0, 32),
      scope: scope.slice(0, 1500),
      intent_evidence: resolution.how === 'prefix'
        ? `The dispatch title «${title}» carries the configured prefix ${resolution.detail}, so it is simple work under auto-route rule ${rule.id}.`
        : `The message «${title}» says ${resolution.detail}, which hands the work to a worker under auto-route rule ${rule.id}.`,
      reason: resolution.how === 'prefix'
        ? `Auto-route ${rule.id}: title prefix ${resolution.detail}`
        : `Auto-route ${rule.id}: dispatch phrase ${resolution.detail}`,
    },
  }
}
