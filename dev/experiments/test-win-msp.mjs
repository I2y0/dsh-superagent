// 在 Windows 上从另一个 MSP 节点发一条信号，验证 msp-ts 进程内订阅能收到。
import { MSPNode } from '../../vendor/msp-ts/dist/index.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = join(homedir(), 'Downloads', 'msp-test')
mkdirSync(dir, { recursive: true })
const file = join(dir, 'Invoice-Win.pdf')
writeFileSync(file, 'invoice for windows test\n')

const node = new MSPNode('windows-demo', { connectPolicy: 'eager' })
await node.start()
for (let i = 0; i < 60 && !node.connections().includes('superagent'); i++) {
  await new Promise(r => setTimeout(r, 250))
}
console.log('peers:', node.connections())
node.publish('file.modified', { name: 'Invoice-Win.pdf', path: file })
await new Promise(r => setTimeout(r, 1200))
node.stop()
console.log('published:', file)
