#!/usr/bin/env node
/**
 * 文件监控节点：盯一个目录，发现新文件就 publish 一条 file.created。
 *
 *   node examples/watch-downloads.mjs                 # 盯 ~/Downloads
 *   node examples/watch-downloads.mjs D:/inbox        # 盯指定目录
 *   node examples/watch-downloads.mjs --node my-watch # 换节点名
 *
 * 它就是一个普通 MSP 节点——不需要知道谁在听，也不需要 dsh 在跑。
 * 文件大小稳定（连续两次相同）之后才发，避免把"正在下载"的半个文件当成新文件。
 */
import { MSPNode } from '../vendor/msp-ts/dist/index.js'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const dir = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--node') || join(homedir(), 'Downloads')
const nodeName = flag('node', 'file-watcher')
const settleMs = Number(flag('settle', '1500'))

const node = new MSPNode(nodeName, { connectPolicy: 'eager' })
await node.start()

const seen = new Map()   // path -> size，用来判断"下载完成"
for (const name of readdirSync(dir)) {
  // -1 表示「已处理/已发」：启动时已有的文件不该再发一遍
  try { seen.set(join(dir, name), -1) } catch { /* 跳过 */ }
}
console.log(`[watch] ${nodeName} 盯着 ${dir}（已忽略 ${seen.size} 个既有文件）`)
console.log(`[watch] 现在下载一个文件试试`)

setInterval(() => {
  let names
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const path = join(dir, name)
    let size
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      size = st.size
    } catch { continue }

    const before = seen.get(path)
    if (before === -1) continue                                    // 已经发过
    if (before === -2) continue                                    // 排队中，等 settle 回调
    if (before === undefined) { seen.set(path, size); continue }   // 第一次见到，等大小稳定
    if (before !== size) { seen.set(path, size); continue }        // 还在长，继续等

    // 大小稳定了：确认一下再发，避免半截文件
    setTimeout(() => {
      try {
        if (statSync(path).size !== size) return                   // 又变了，下一轮再说
        seen.set(path, -1)                                          // 标记已发，不再重复
        node.publish('file.created', { name: basename(path), path, bytes: size })
        console.log(`[watch] → file.created  ${name}  ${size} 字节`)
      } catch { /* 文件没了 */ }
    }, settleMs)
    seen.set(path, -2)                                              // 排队中，别重复入队
  }
}, 700)

process.on('SIGINT', () => { node.stop(); process.exit(0) })
