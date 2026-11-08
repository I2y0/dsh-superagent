# 把 MSP 接进 Super-agent：九条坑，和三次我以为自己对的时候

> 记录一次真实的技术过程。不是教程，是**踩坑记**——包括我判断错的地方。

---

## 起点

目标只有一句：让 `dsh-superagent-prototype` 能听见本机信号，而不是只轮询 GitHub。

它的感知在 `src/sources/poll.ts`：

```
POLL_HORIZON_MS = 14 天
cursorAt(): 轮询起点回退 5 秒，防漏事件
```

要换成 MSP 的推送。我以为这是一天的活。

---

## 九条坑

### K1 `spawn env ENOENT`

部署检查用 POSIX 的 `env` 改 PATH 再跑 `gh`：

```ts
runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], ...)
```

Windows 没有 `env.exe`。**任何** GitHub 配置都会失败，报「读不到账号」。

### K2 强制 GitHub 仓库

```ts
if (!remote) throw new SetupError('repositoryUnset')
```

`Deployment` 这个类型本身就是「一个有仓库的部署」。只想用本机信号？不行，整张面板卡在 setup。

### K3 `stateDir` 缺失，整行不挂载

缺一个必填配置，面板不说「缺配置」，只说「dsh-superagent 没有响应」。

**错误指向了错误的方向。**

### K4 `tools.restrict() names unknown global tool "bash"`

worker 的工具白名单写死了 `bash`，Windows 上只有 `pwsh`。于是 orchestrator 初始化失败，三个 Source 全 `pending`。

### K5 僵尸节点占着租约

插件每次重载都 `new MSPNode('superagent')`，旧的没停。旧节点仍占着 `~/.msp/nodes/superagent.json` 里的端口，发布方连过去连的是「没人读」的那个。

现象最迷惑：**发送端 `sent` 成功，接收端一帧都没收到。**

定位方法救了命——**两个裸 msp-ts 节点做隔离实验**：能通，说明问题在宿主侧的实例管理，不在协议。

### K6 `patternMatches` 不认裸 `**`

```js
if (pattern === path) return true
if (pattern.endsWith('.**')) ...
if (pattern.endsWith('.*')) ...
return false      // '**' 落到这里，永远 false
```

订阅 `**` 等于什么都没订阅。

### K7 `which('dsh')` 拿到 `.ps1`

`subprocess` 执行不了 PowerShell 脚本，报 `WinError 2`。改成优先 `.cmd` / `.exe`。

### K8 profile 的 `[]` 让 YAML 粘连

新建 profile 的 patch 文件内容是「注释 + `[]`」。往里追加条目：

```yaml
[]
- id: dsh-superagent
```

两个 YAML 文档粘一起，解析直接失败。

### K9 准入层只认 `policy.rules`

这条最贵。经验命中、注入、模型也读到了——决策文本里明确写着 `with an archiving experience hint`——**但它还是 `ignore`**：

```
touches no enabled rule (copy fixes, visual fixes)
```

补一条通用规则之后才通：

```
Any event from the local MSP source is in scope for assessment.
When the Trigger carries an experience block, follow it by its trust level.
An event that no experience covers is not admissible.
```

---

## 三次我以为自己对的时候

### ① 我用错的 URL 测了五遍

我拿 `/plugins/<包>/client.js` 判断插件有没有加载，连测五次 404，然后据此删 profile、重建 home、改了四处配置。

后来发现 **dsh 的客户端清单是逗号拼接的合并 URL**，内置插件在同一个路径下也是 404。

**五次 404 一次都没有验证到东西。**

### ② 我把错误吞了

```ts
void Promise.resolve(ctx.receive(trigger)).catch(() => undefined)
```

为了「信号链路不该打断服务」，我把异常吞了。结果「信号为什么没进 Engine」查了半天。改成写进 health 之后，问题立刻可见。

**为了稳，把证据也一起扔了。**

### ③ A/B 实验被自己污染两次

第一次：信号指向的文件根本不存在，模型去查了文件系统，发现我在骗它。
第二次：我早前把同样的规则也写进了提示词，所以「无经验」组照样能干活。

**两次都得到了「没有差异」的结论，两次的结论都无效。**

---

## 最后两个发现

### 发现一：主动性缺的是「嘴」，不是策略

L3（先问后做）在无人称信号上**不可执行**。Agent 自己说的：

```
the confirmation question cannot be delivered —
the MSP source (msp:file.created) has no reply channel
```

它拒绝移动文件、去找有没有别的通道、读了源码确认 `SourceChannel` 没实现、然后如实报告 blocked。

**它没有瞎猜、没有硬来、也没有假装问过了。**

### 发现二：经验写不可执行，模型就会自己发明实现

同一个文件、同一条经验，只改措辞：

| 经验写的是 | 实测 |
|---|---|
| 「弹一个轻量通知」 | 48 秒、几十轮工具调用、搜遍全盘、还去查了 Windows 通知数据库 |
| 「只做三件事：判断 → 移动 → report；不读无关目录、不查系统数据库」 | **13 秒，三步结束** |

**只有可执行的经验才叫经验，写不清的那是愿望。**

---

## 三段对照，都有磁盘为证

| 信号 | 经验 | 行为 |
|---|---|---|
| `clipboard.changed` | 无 | 静默，`ignore`，「无经验覆盖」 |
| `Spec-2026.pdf` | `doc-archive` L3 | 开单、卡在 `person`、文件原地不动 |
| `Brief-2028.pdf` | `doc-archive` L1 | 13 秒移动到 `Documents/Work/` |

---

## 这段曲折说明了什么

1. **主动性不是"更会说话"，是"知道什么时候不说话"** —— 三次运行里两次是安静，而安静都是对的。
2. **信任分级不是配置项，是执行边界** —— 只改一个数字（L3→L1），行为从"问"变成"做"。
3. **经验的写法比经验的数量重要** —— 一条写清楚的，胜过十条模糊的。
4. **报错指向错误的方向，是这类系统最大的隐患** —— K3 和 K4 都是「面板说没有响应，真因在日志里一行 RemoteError」。

九个坑里，**五个是上游的 Windows 假设，两个是 msp-ts 的，两个是我自己的。**
全部记在 [`docs/known-issues.md`](../docs/known-issues.md)。
