/**
 * dsh-msp-filewatch —— 目录里的新文件 → MSP 信号。
 *
 * 它同时是两样东西：
 *   1. 一个 dsh 插件（由 cordis.patch.yml 挂载）
 *   2. 一个 MSP 节点（自己起一个 MSPNode，别人不需要知道它在哪）
 *
 * 只监控目录的**直接子项**，不进子目录（不递归）。
 */
import { MSPNode } from './msp/index.js'
import { readdirSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const name = 'msp-filewatch'

export function apply(ctx, config = {}) {
  const dirs = (config.dirs?.length ? config.dirs : [join(homedir(), 'Downloads')])
  const nodeName = config.nodeName || 'filewatch'
  const settleMs = Number(config.settleMs ?? 1500)
  const extensions = (config.extensions ?? []).map(e => e.replace(/^\./, '').toLowerCase())

  /** path -> -1 已发 / -2 排队中 / 数字 上次看到的大小 */
  const seen = new Map()
  let node = null
  let stopped = false
  const timers = new Set()

  const log = (msg) => ctx.logger?.info?.(`[msp-filewatch] ${msg}`) ?? console.log(`[msp-filewatch] ${msg}`)

  const key = (path) => path
  const wanted = (name) => {
    if (name.startsWith('.')) return false
    if (!extensions.length) return true
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
    return extensions.includes(ext)
  }

  const publish = (path, size) => {
    if (!node || stopped) return
    node.publish('file.created', { name: basename(path), path, bytes: size })
    log(`file.created ${basename(path)} ${size}B`)
  }

  const scan = (dir) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (!wanted(name)) continue
      const path = join(dir, name)
      let size
      try {
        const st = statSync(path)
        if (!st.isFile()) continue          // 目录直接跳过：不递归
        size = st.size
      } catch { continue }

      const before = seen.get(key(path))
      if (before === -1 || before === -2) continue
      if (before === undefined) { seen.set(key(path), size); continue }   // 首次见到，等稳定
      if (before !== size) { seen.set(key(path), size); continue }        // 还在长

      seen.set(key(path), -2)                                            // 排队
      const timer = setTimeout(() => {
        timers.delete(timer)
        try {
          if (statSync(path).size !== size) { seen.set(key(path), size); return }  // 又变了
          seen.set(key(path), -1)
          publish(path, size)
        } catch { seen.set(key(path), -1) }                              // 文件没了也算处理过
      }, settleMs)
      timers.add(timer)
    }
  }

  ctx.effect(() => {
    let alive = true
    const closers = []
    ;(async () => {
      node = new MSPNode(nodeName, { connectPolicy: 'eager' })
      await node.start()
      if (!alive) { node.stop(); return }
      log(`节点 ${nodeName} 已启动，监控 ${dirs.join(', ')}（不递归）`)

      for (const dir of dirs) {
        try {
          for (const n of readdirSync(dir)) {
            try { seen.set(key(join(dir, n)), -1) } catch { /* 忽略 */ }   // 既有文件不重发
          }
        } catch { log(`目录不可读: ${dir}`) }
        try {
          const w = watch(dir, { recursive: false }, () => scan(dir))
          closers.push(() => { try { w.close() } catch { /* 忽略 */ } })
        } catch { log(`无法监控: ${dir}`) }
        const interval = setInterval(() => scan(dir), 1000)              // watch 不可靠时兜底
        closers.push(() => clearInterval(interval))
      }
    })().catch(error => log(`启动失败: ${error?.message ?? error}`))

    // 同步返回清理函数：Cordis 在卸载插件时调用它
    return () => {
      alive = false
      stopped = true
      for (const close of closers) close()
      for (const t of timers) clearTimeout(t)
      timers.clear()
      try { node?.stop() } catch { /* 忽略 */ }
      node = null
      log('已停止')
    }
  })
}
