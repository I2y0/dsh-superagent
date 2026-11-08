# 测试任务书（给执行测试的 Agent）

> **你只做测试，不改代码。** 需要改动时先停下来问，不要"顺手优化"。

---

## 0. 环境现状

```
仓库   C:\Users\asus\dsh-superagent-prototype\      （已装好，服务在跑）
隔离家 C:\Users\asus\dsh-superagent-prototype\.dsh\  （不是 ~/.dsh）
状态库 C:\Users\asus\dsh-superagent-prototype\.dsh\state\superagent\
经验库 C:\Users\asus\.dsh\tacit\experiences\
服务   http://127.0.0.1:3080/orchestrator/api      （请求头必须带 x-orchestrator-request: 1）
监控源 C:\Users\asus\Downloads\msp-test\
归档区 C:\Users\asus\Documents\Work\
```

`dsh` 在 `F:\...\dsh-superagent-msp\.tools3\node_modules\.bin\`。

---

## 1. 先修状态：锁残留

上一个操作方用 `Stop-Process -Force` 强杀了服务，`proper-lockfile` 的锁没释放，所以现在：

```
dsh-superagent: Error: Lock file is already being held
```

**步骤：**

```powershell
# 1) 确认端口归属
Get-NetTCPConnection -LocalPort 3080 | Select-Object -ExpandProperty OwningProcess

# 2) 正常停（带短超时，不要强杀）
cd $HOME\dsh-superagent-prototype
$env:DSH_HOME="$PWD\.dsh"
$env:PATH="F:\...\dsh-superagent-msp\.tools3\node_modules\.bin;$env:PATH"
python scripts/dsh-superagent stop --stop-timeout 10

# 3) 清锁（只删锁，不删状态）
Get-ChildItem "$env:DSH_HOME\state\superagent" -Recurse -Filter ".lock" -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

# 4) 起
python scripts/dsh-superagent start --timeout 40
```

**验收：**

```powershell
curl.exe -s -H "x-orchestrator-request: 1" http://127.0.0.1:3080/orchestrator/api/sources
```

期望 `msp` 的 `state` 是 `ready`，health 里有 `listening: **`。
**不是 ready 就停下报告，不要继续。**

---

## 2. 实验一：单事件成本（先做这个）

**目的**：确认修完去重/锁之后，**一条事件的正常成本**是多少（此前的 627K 是事件风暴造成的，不代表正常值）。

**步骤：**

1. 记录起始：`GET /settings` 里无 token 数据，改为记录**决策条数**与**工单条数**
2. 造一个**新文件**（名字必须是以往没出现过的）：

```powershell
Set-Content "$env:USERPROFILE\Downloads\msp-test\Probe-A.docx" -Value "ablation A"
```

3. 发**一条**事件（不要用目录监控循环，会重复）：

```javascript
// 在仓库根目录执行
node -e "
import('./vendor/msp-ts/dist/index.js').then(async ({MSPNode})=>{
  const n=new MSPNode('probe',{connectPolicy:'eager'}); await n.start();
  for(let i=0;i<50 && !n.connections().includes('superagent');i++) await new Promise(r=>setTimeout(r,200));
  n.publish('file.created',{name:'Probe-A.docx',path:'C:/Users/asus/Downloads/msp-test/Probe-A.docx',bytes:9});
  await new Promise(r=>setTimeout(r,1500)); n.stop(); console.log('published once');
})"
```

4. 等 60 秒，采集：

| 字段 | 从哪取 |
|---|---|
| 决策条数增量 | `GET /decisions?limit=5` |
| 决策 kind | 同上 |
| 是否命中经验 | `GET /sources` 里 `msp.health.detail` 的 `exp N/M` |
| 工单数 | `GET /tickets?limit=5` |
| 文件最终位置 | `Test-Path` 两个目录 |

**产出**（必须贴原始 JSON，不要只写结论）：

```
decisions 增量: N
kind: accept / ignore
exp: N/M
tickets: N
文件: Downloads / Documents\Work
```

---

## 3. 实验二：经验消融（确认实验一通过后再做）

**目的**：有经验 vs 无经验，对**任务完成率**和**经验读取率**的影响。

**设计：** 3 个文件 × 2 组 × 1 轮，不并发。

| 组 | 经验目录 | 处理 |
|---|---|---|
| A | 清空（改名备份） | 3 个文件各发一条事件 |
| B | 恢复 `doc-archive` | 3 个文件各发一条事件 |

**关键控制（前两次实验都栽在这里）：**

- 文件**必须真实存在**，事件里的 `bytes` 必须与磁盘一致
- 提示词里**不能**有「文件归档」的同类规则——检查 `GET /prompts` 的 `delivery` / `scope` 段，有就先备份再删
- 每次只发**一条**，等 60 秒再下一条，**绝不并发**
- 每组用全新的文件名，避免与历史 thread 撞车

**采集表：**

| 组 | 文件 | 决策 kind | exp 命中 | 工单 | 最终位置 |
|---|---|---|---|---|---|
| A | Abl-A1.docx | | | | |
| A | Abl-A2.pdf | | | | |
| A | Abl-A3.docx | | | | |
| B | Abl-B1.docx | | | | |
| B | Abl-B2.pdf | | | | |
| B | Abl-B3.docx | | | | |

**两个指标：**

```
经验读取率 = 整组里 exp > 0 的事件数 / 3
任务完成率 = 整组里最终落到 Documents\Work 的文件数 / 3
```

---

## 4. 严禁

1. **不要 `Stop-Process -Force`** —— 会留下 `proper-lockfile` 锁，上一个操作方就是这么把环境搞坏的
2. **不要起目录监控循环** —— 实测每秒一条会形成事件风暴，烧掉 60 万 token
3. **不要并发发事件** —— 编排器批处理会把它们混在一起判断
4. **不要改 `src/` 里的任何文件** —— 只测试
5. **不要动 `~/.dsh`** —— 那是操作者本人的环境，测试只碰 `.dsh`

---

## 5. 交付

一份 markdown，含：

1. 实验一的原始 JSON
2. 实验二的采集表 + 两个指标的计算过程
3. 任何异常的原样报错（不要转述）
4. 一句话结论：**经验对完成率有没有可观测的影响**

**如果数据不足以得出结论，就写"不足以下结论"并说明缺什么。不要凑。**
