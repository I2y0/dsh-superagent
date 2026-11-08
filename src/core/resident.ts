/** Semi-resident tickets: a ticket whose work items finish without ending, until one of its cleaning rules rotates it. */
import type { Ticket } from './model.ts'

/** A week, after which a resident ticket rotates by default: it started this long before its latest finished item. */
export const RESIDENT_WEEK_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Why a resident ticket rotates: it finished as many items as the rule allows (`rounds`), its worker's context filled
 * (`context`), an item failed or blocked since the last one (`error`), its week passed (`weekly`), or a new ticket started
 * work in another scenario (`scenario`). A rotated ticket ends, so the next Trigger in its scenario opens a fresh one.
 */
export type RotationReason = 'rounds' | 'context' | 'error' | 'weekly' | 'scenario'
/**
 * The cleaning rules of a resident ticket. `maxRounds` of 0 disables the item count, `maxContextPercent` of 0 the context
 * rule, and each `on*` switch its own rule; `enabled: false` ends every ticket as it did before tickets were resident.
 */
export interface ResidentRules {
  enabled: boolean
  maxRounds: number
  maxContextPercent: number
  weekly: boolean
  onError: boolean
  onScenarioChange: boolean
}
/**
 * The rules a Policy without its own (an older embedder, a fixture) gets. Residency is off unless a deployment turns it on:
 * ending a finished ticket is the behaviour every existing installation and test expects, and a semi-resident worker keeps
 * a session alive, which is a deployment's choice.
 */
export const RESIDENT_RULES: ResidentRules = { enabled: false, maxRounds: 10, maxContextPercent: 80, weekly: true, onError: true, onScenarioChange: true }
/**
 * Whether a ticket waits between work items: it is open and its latest item finished, with nothing running. A person's message
 * on one of its Threads, or a Trigger or note attached to it, gives it work again.
 */
export const idleResident = (ticket: Pick<Ticket, 'ended' | 'resident'>): boolean => !ticket.ended && !!ticket.resident?.idleSince
/**
 * The cleaning rule that rotates `ticket` once it finishes `state`'s latest item at `at`, or undefined when none does.
 * The item count and the context rule read the residency this completion leaves behind; the error one reads what failed
 * since the item before it, and the weekly one when the residency began.
 */
export function rotationReason(ticket: Pick<Ticket, 'resident'>, rules: ResidentRules, at: string): RotationReason | undefined {
  const state = ticket.resident
  if (!state) return undefined
  if (rules.onError && state.error) return 'error'
  if (rules.maxRounds > 0 && state.rounds >= rules.maxRounds) return 'rounds'
  if (rules.maxContextPercent > 0 && (state.contextPercent ?? 0) >= rules.maxContextPercent) return 'context'
  if (rules.weekly && Date.parse(at) - Date.parse(state.since) >= RESIDENT_WEEK_MS) return 'weekly'
  return undefined
}
/** The reason a rotated ticket's end records, and what its successor's handoff names. */
export const rotationLabel = (reason: RotationReason): string => `rotation:${reason}`
/** The rotation reason an ended ticket's `ended.reason` records, or undefined when it ended for another reason. */
export const rotationOf = (reason: string | undefined): RotationReason | undefined => {
  const named = reason?.startsWith('rotation:') ? reason.slice('rotation:'.length) : undefined
  return named === 'rounds' || named === 'context' || named === 'error' || named === 'weekly' || named === 'scenario' ? named : undefined
}
