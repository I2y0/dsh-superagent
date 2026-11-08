#!/usr/bin/env node
/**
 * ReActive 最小示例 —— 不需要 dsh、不需要 MSP、不需要 GUI。
 *
 *   node examples/minimal/demo.mjs
 *
 * 三个回合，同一个信号，三种结局：
 *   A  没有经验覆盖        → 静默
 *   B  经验 doc-archive L1  → 直接办
 *   C  同一条经验 L3        → 等你点头
 *
 * 它做的事是真的：真的建文件、真的移文件、真的记录回执。
 * 打印出来的轨迹就是论文里那种 Thought/Action/Observation 的格式。
 */
import { mkdirSync, writeFileSync, existsSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(tmpdir(), 'reactive-minimal')
const INBOX = join(ROOT, 'Downloads')
const WORK = join(ROOT, 'Documents', 'Work')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(INBOX, { recursive: true })
mkdirSync(WORK, { recursive: true })

// ---------------------------------------------------------------- 经验库
const EXPERIENCES = [
  {
    id: 'doc-archive',
    trigger: 'file.**',
    condition: (ctx) => ['pdf', 'docx'].includes(ctx.file.extension),
    trust: 'L1',
    act: (ctx) => {
      const target = join(WORK, ctx.file.name)
      renameSync(ctx.file.path, target)
      return `moved to Documents/Work/${ctx.file.name}`
    },
  },
]

const TRUST_LEVELS = {
  L1: { label: 'act silently', needsConsent: false },
  L2: { label: 'act and notify', needsConsent: false },
  L3: { label: 'ask first', needsConsent: true },
  L4: { label: 'report only', needsConsent: true },
}

// ---------------------------------------------------------------- 管道
const log = (tag, text) => console.log(`  ${tag.padEnd(11)} ${text}`)

/** 2.3.1 结构准入：只看信封，不需要模型。 */
function structuralAdmit(event, library) {
  if (event.source !== 'local') return { ok: false, why: 'source not listened' }
  const covered = library.some((e) => e.condition(event))
  if (!covered) return { ok: false, why: 'no experience covers this event' }
  return { ok: true }
}

/** 2.3.2 语义准入：只看幸存者，给出四档之一。 */
function semanticAdmit(event, experience) {
  const base = event.type === 'file.created' ? 0.7 : 0.3
  const urgency = experience.trust === 'L1' ? 0.9 : 0.6
  const quiet = 1.0
  const score = base * urgency * quiet
  const verdict = score > 0.5 ? 'interrupt' : score > 0.2 ? 'digest' : 'record'
  return { score, verdict }
}

function run(title, event, experience, opts = {}) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
  log('Signal', `${event.type} ${JSON.stringify({ name: event.file.name, bytes: event.file.bytes })}`)

  const gate = structuralAdmit(event, opts.library ?? EXPERIENCES)
  log('Gate', gate.ok ? 'structural: admitted' : `structural: REJECTED (${gate.why})`)
  if (!gate.ok) {
    log('Receipt', `held back — ${gate.why}`)
    return { outcome: 'held_back' }
  }

  log('Experience', `${experience.id} matched  (trust=${experience.trust}, ${TRUST_LEVELS[experience.trust].label})`)
  const adm = semanticAdmit(event, experience)
  log('Admission', `s=${adm.score.toFixed(2)} -> ${adm.verdict}`)

  if (TRUST_LEVELS[experience.trust].needsConsent) {
    const exists = existsSync(event.file.path)
    log('Act', 'declined — consent required, and this source has no reply channel')
    log('Receipt', `waiting — "move ${event.file.name} to Documents/Work/?"   (file kept: ${exists})`)
    return { outcome: 'waiting' }
  }

  const result = experience.act({ file: event.file })
  log('Act', result)
  log('Receipt', `done — ${result}`)
  return { outcome: 'done' }
}

// ---------------------------------------------------------------- 三个回合
const name = 'Invoice-2026.pdf'
const bytes = 18234
const path = join(INBOX, name)
writeFileSync(path, 'x'.repeat(bytes))
const event = { type: 'file.created', source: 'local', file: { name, path, bytes, extension: 'pdf' } }

const r0 = run('A. 没有经验覆盖：这件事不该存在', event, null, { library: [] })

const exp = EXPERIENCES[0]
const r1 = run('B. 经验 doc-archive，L1（授权：直接办）', event, exp)

// 第二轮开始前把文件放回来，模拟"同一个信号再次发生"
writeFileSync(path, 'x'.repeat(bytes))
exp.trust = 'L3'
const r2 = run('C. 同一条经验，只把 L1 改成 L3（授权：先问）', event, exp)

// ---------------------------------------------------------------- 结果
console.log(`\n${'='.repeat(72)}\n结果\n${'='.repeat(72)}`)
console.log('  A  held_back')
console.log(`  B  ${r1.outcome}`)
console.log(`  C  ${r2.outcome}`)
console.log(`\n  Documents/Work/: ${readdirSync(WORK).join(', ') || '(空)'}`)
console.log(`  Downloads/:      ${readdirSync(INBOX).join(', ') || '(空)'}`)
console.log(`\n  同一条经验、同一个信号、同一个执行者——只有 trust level 不同。\n`)
