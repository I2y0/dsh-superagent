# dev/ — 开发期一次性材料

这里放**不进包、不参与构建、也不被任何代码引用**的东西：当初验证某个结论时跑过的脚本和交接单。
留着是因为它们记录了「这个结论是怎么测出来的」，比 `git log --diff-filter=D` 好找。

`package.json` 的 `files` 不含 `dev/`，所以发布包里没有这些文件。

| 文件 | 是什么 |
|---|---|
| `experiments/ab2.sh` | 经验注入 A/B：清空经验库跑一轮、恢复再跑一轮，比对 `/decisions`。路径写死为 Linux/WSL 的 `/root/...` |
| `experiments/ab3.sh` | 同一个 A/B 的第三轮，多了决策 id 去重 |
| `experiments/probe.sh` | 探 `/orchestrator/api` 下各端点是否在线（需要服务在 `127.0.0.1:3080` 跑着） |
| `experiments/test-win-msp.mjs` | 在 Windows 上从另一个 MSP 节点发一条 `file.modified`，验证 `msp-ts` 进程内订阅收得到 |
| `test-brief.md` | 2026-11 给执行测试的 Agent 的一次性任务书，里面的路径是那台机器的 |

跑法：`ab2.sh` / `ab3.sh` 依赖目标机器上 `python3 -m msp`、`/root/sa` 与服务同时在跑，换机器要改路径；
`test-win-msp.mjs` 用 `node dev/experiments/test-win-msp.mjs`，前提是 `vendor/msp-ts` 已装好、服务在跑。
