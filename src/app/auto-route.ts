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
import { join } from 'node:path'
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
}).strict().refine(rule => rule.prefixes.length > 0 || rule.phrases.length > 0,
  'A rule needs at least one title prefix or one text phrase')
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
  return payload
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
interface Resolution { rule: AutoRouteRule; decision: 'accept' | 'silent'; how: 'prefix' | 'phrase'; detail: string; title: string; payload: Record<string, unknown> }

/** The rule that settles one Trigger, or `undefined` when it is the seat's to decide. */
function resolveTrigger(trigger: Candidate['triggers'][number], config: AutoRouteConfig): Resolution | undefined {
  if (!config.enabled || config.rules.length === 0) return undefined
  let silent: Resolution | undefined
  for (const rule of config.rules) {
    const payload = speaksFor(trigger, rule, config)
    if (!payload) continue
    // An explicit opt-out in the payload wins over every rule.
    if (payload.autoRoute === false) return undefined
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    if (!title) return undefined
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

/** The resolution every Trigger of one Eval agrees on, or `undefined` when the seat should decide the batch. */
function resolveCandidate(candidate: Candidate, config: AutoRouteConfig): Resolution | undefined {
  if (!config.enabled || config.rules.length === 0) return undefined
  if (candidate.triggers.length === 0) return undefined
  let resolved: Resolution | undefined
  for (const trigger of candidate.triggers) {
    const item = resolveTrigger(trigger, config)
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
export function autoRouteAssessment(candidate: Candidate, settings: Settings, config: AutoRouteConfig | undefined): AutoRouteChoice | undefined {
  if (!config) return undefined
  const resolution = resolveCandidate(candidate, config)
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
