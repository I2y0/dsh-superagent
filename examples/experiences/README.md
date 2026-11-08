# 经验怎么写

一条经验一个 `.md`，放在 `~/.dsh/tacit/experiences/`。格式：

```yaml
---
id: doc-archive                 # 唯一，小写
trigger: file.created           # 信号路径；支持 file.** 与同族匹配（file.created ≈ file.modified）
condition: file.extension in ["pdf", "docx"]    # 支持 true / == / in [...]
action: ……                      # 做什么、用什么做、不许做什么
trust_level: L1                 # L1 直接办 / L2 办完通知 / L3 先问 / L4 只报
---
# 标题
为什么这么做。
```

## 三条硬规矩

1. **写"用什么做"**。只写「弹一个轻量通知」而不说用什么弹，模型会自己发明实现——
   实测多花了 35 秒和几十轮工具调用。
2. **写边界**。「不读无关目录、不查系统数据库」能挡住绝大多数越界探索。
3. **等级要克制**。默认写 L3；确认这条规则很少出错之后再降到 L1。
   分级决定它敢做什么，不是模型的心情。

## 对照

| 信号 | 经验 | 行为 |
|---|---|---|
| `clipboard.changed` | 无 | 静默（`ignore`，无经验覆盖） |
| `Spec-2026.pdf` | `doc-archive` L3 | 开单、等人、文件不动 |
| `Brief-2028.pdf` | `doc-archive` L1 | 13 秒移动完成并报告 |
