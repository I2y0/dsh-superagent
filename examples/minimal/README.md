# 最小示例

不需要 dsh、不需要 MSP、不需要 GUI。

```bash
node examples/minimal/demo.mjs
```

三个回合，同一个信号，三种结局：

| 回合 | 条件 | 结局 |
|---|---|---|
| A | 没有经验覆盖 | `held_back` — 静默 |
| B | 经验 `doc-archive`，**L1** | `done` — 移动了文件 |
| C | 同一条经验，只把 L1 改成 **L3** | `waiting` — 等你点头，文件没动 |

它做的是真事：真建文件、真移文件、真记录回执。`trace.txt` 是它的完整输出。

## 为什么要有这个

论文里的架构图解释"发生了什么"，这个示例解释"**它凭什么这么做**"。

三行就能看出重点：

```
Gate        structural: REJECTED (no experience covers this event)
Experience  doc-archive matched  (trust=L1, act silently)
Act         declined — consent required, and this source has no reply channel
```

第一行：没经验 → 门都没进。
第二行：有经验 → 命中，且自带授权等级。
第三行：授权 L3 → 它想问你，但没有嘴。

## 它省略了什么

- 没有 MSP（信号是直接构造的，不是推来的）
- 没有模型（打分是常数，不是判断）
- 没有持久化（回执只打印）

**这三样都在主仓库里，但这个示例故意不带**——最小示例的价值是让人三十秒看懂机制，不是复现系统。
