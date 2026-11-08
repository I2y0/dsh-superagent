# 已知问题（Windows / 非 GitHub 部署）

## K1. `spawn env ENOENT` —— 部署检查在 Windows 上必然失败

**位置**：`src/deployment.ts:75`

```ts
return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, ...)
```

**原因**：用 POSIX 的 `env` 命令改 PATH。Windows 没有 `env.exe`，于是
`gh api user` 这条探测永远 spawn 失败，报 `env ENOENT`，面板显示
「智能体的 GitHub CLI 读不到它的账号」。

**影响**：Windows 上**任何** GitHub 来源都配不成，与填什么无关。

**同样的写法还有**：`src/deployment.ts:120`（飞书 CLI 探测）。

**修法**：按平台分支，Windows 直接把 PATH 放进子进程 env：

```ts
if (process.platform === 'win32') {
  return argv => runAsWorker(subprocess, argv, cwd, signal, { PATH: path })
}
```

需要 `runAsWorker` 支持传 env（没有就在调用处改成 `spawn(..., { env })`）。

---

## K2. 部署检查强制要求 GitHub 仓库，挡住「只用 MSP」

**位置**：`src/deployment.ts:91`

```ts
const remote = accounts.repository
if (!remote) throw new SetupError('repositoryUnset')
```

**原因**：`Deployment` 类型本身就是「一个有仓库的部署」，`repository` 与
`accounts` 都是必填；`Executor` / `Ticket` / `Worker` 都从 `deployment.repository` 取值。

**影响**：即使只想要本机 MSP 信号，也必须先配一个 GitHub 仓库，
否则整个 setup 不通过，面板停在 `setup` 状态。

**修法（两层）**：

1. **最小**：GitHub 来源被禁用时跳过 `repositoryUnset` 检查，让 setup 通过
2. **正解**：把 `Deployment` 拆成 `repo` / `local` 两种联合类型，
   下游按 `kind` 分支——`local` 模式下 Executor 走本地目录、不开 PR

第 1 层能立刻解除阻塞，但 `local` 模式下点开 Ticket 相关页面仍可能报错；
第 2 层是真正的产品化改造。

---

## K3（已修复）. `stateDir` 缺失导致整行挂载不上

**位置**：`src/deployment.ts:16`

`stateDir` 曾是 `.required()`，但 `--from-default-profile` 建出来的 profile
不会写它。缺了不会报「缺配置」，而是整行 mount 失败，面板只显示
「dsh-superagent 没有响应」——错误指向了错误的方向。

**修法**：schema 给默认值 `<DSH home>/state/superagent`（`DSH_HOME` 改了它也跟着改），
所以从插件市场直装就能挂上；profile 里写了 `stateDir` 仍然覆盖默认值。
`scripts/dsh-superagent init` 仍会显式写一条，是为了让路径可见。

---

## K4. `tools.restrict() names unknown global tool "bash"` —— Windows 上 orchestrator 初始化失败

**位置**：`src/app/sessions.ts:263`

```ts
agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', ...] })
```

**原因**：worker 会话的工具有名单写死了 POSIX 的 `bash`。Windows 上的 dsh 只提供
`pwsh`，于是 `restrict()` 拒绝创建会话 → `orchestrator` 初始化失败 →
`dsh-superagent` / `dsh-superagent-github` / `dsh-superagent-msp` 全部停在 `pending`，
面板显示「dsh-superagent 没有响应」。

**症状与真因的距离**：面板说的是「没有响应 / 可能正在重启」，真正的原因在
DSH 日志里的一行 `RemoteError`。这也是 K3 的同款问题：**错误指向了错误的方向。**

**修法**（已在本 fork 实现）：

```ts
allow: ['skill', process.platform === 'win32' ? 'pwsh' : 'bash', 'read', ...]
```

`src/app/sessions.ts:61` 的 `WORK_TOOLS` 也把 `bash` 和 `pwsh` 都列着，
Windows 上过滤掉不存在的那一个更干净。

---

## K5（已修复）. 收不到信号：旧 MSP 节点没停，占着租约

**位置**：`src/sources/msp.ts` 的 `runMsp`

**症状**：发布端 `publish` 成功（`[msp-dbg] sent to=superagent`），服务端
`dispatch` 一条消息都收不到，`received: 0`。两侧对同一条连接的状态判断不一致。

**原因**：插件每次重载都会 `new MSPNode('superagent')`，旧节点没有 `stop()`。
旧节点仍占着租约（`~/.msp/nodes/superagent.json`）与端口，新节点抢不到连接，
发出方连过去连的是那个已经没人读的僵尸节点。

**为什么只在插件里复现**：裸跑两个节点只加载一次；插件会被反复 reload。

**修法**：模块级单例，起新的之前先停旧的：

```ts
let currentNode: { stop(): void } | null = null
// runMsp 开头
if (currentNode) { try { currentNode.stop() } catch {} currentNode = null }
// start 之后
currentNode = node
```

**定位方法**（值得记）：用两个裸 msp-ts 节点做隔离实验——如果能通，问题就在
宿主侧的实例管理，不在协议。

---

## K6（已修复）. `patternMatches` 不认裸 `**`

`'**'` 既不等于任何路径，也不以 `.**` / `.*` 结尾，旧的 `patternMatches` 直接
`return false`。所以订阅 `**` 等于什么都没订阅。已在 `vendor/msp-ts` 里补上
`pattern === '**' || pattern === '*'`（应向上游反馈）。

---

## K7. 单账号部署：GitHub 来源把每条事件都当成智能体自己发的，静默丢弃

**位置**：`src/sources/github.ts` 的 `readStream()`（仓库级 issues / comments 流）与 `intakeComments()`（通知、订阅线程的评论）

```ts
if (sameName(item.user.login, login)) continue
```

**症状**：`kv` 里 `github-since`、`github-stream:*` 游标照常前进，来源 health 仍是 `ready`（`0 notifications; next poll ≥ 60s`），
但 `trigger` / `disposition` / `thread` 全是 0 行，面板「到达 0 / 被过滤 0」。在监听的仓库里新建 Issue、发评论都没有反应。

**原因**：来源按设计丢弃「智能体自己的 GitHub 账号」发出的事件（`docs/001-domain.md`、`docs/008-cookbook.md`：Source 在进入领域前
丢掉 bot 自己的消息），这要求智能体有独立账号（`docs/006-deployment.md` 的 Agent GitHub account）。若 `gh api user` 登录的账号
就是发请求的账号（单账号部署），每条事件都属于「自己发的」，在入库前被静默丢弃 —— 不生成 trigger，也不写 disposition，
所以连「被过滤」都是 0。

**判定方法**：`gh api user --jq .login` 与 Issue / 评论作者比对；面板 GitHub 卡片的 facts「当前账号 @…」是同一个值。

**修法**：
1. 给智能体一个独立的 GitHub 账号（`docs/006-deployment.md`），人用另一个账号发请求；
2. 本版起，被忽略的条数写进来源 health：`3 from @<账号> (the agent's own account) ignored`，单账号部署不再无迹可循。

**是否支持单账号部署是产品决策**：要区分「智能体自己发的回复」和「人用同一账号提的请求」，只能靠 outbox 的
`<!-- dsh-superagent:… -->` marker 或提示词首行这类信号，而且智能体自己开的 PR / 评论有回环风险，不能在没有决策的情况下改。
