/**
 * 共享目录发现/宣告 —— 与 msp-py 的 DirectoryScan / DirectoryWrite 文件契约对齐。
 *
 * 声明文件：`<nodes_dir>/<node_id>.json`
 *   { "node_id": "...", "endpoint": {"transport_type": "tcp",
 *                                       "address": {"host": "...", "port": N}},
 *     "timestamp": <float 秒> }
 *
 * timestamp 是租约：超过 staleAfter 未续租的声明视为过期（节点已崩溃），
 * 从邻居表消失。续租间隔 5s < 过期阈值 30s，容忍连续几次续租丢失。
 *
 * 去重按「整个声明对象的规范化 JSON」哈希——timestamp 每次续租都变，
 * 所以每次续租都会重新触发 onAdd（对端据此重拨/刷新），与参考实现一致。
 */
import type { DiscoveredEndpoint, Discovery } from "./base.ts";
export declare class DirectoryDiscovery implements Discovery {
    private readonly known;
    private pollTimer;
    private readonly nodesDir;
    private readonly selfId;
    private readonly staleAfterMs;
    private readonly pollIntervalMs;
    onAdd: (ep: DiscoveredEndpoint) => void;
    onRemove: (nodeId: string) => void;
    constructor(nodesDir: string, selfId: string, staleAfterMs?: number, pollIntervalMs?: number);
    /** 启动轮询。立即扫一次，不等第一个周期。 */
    start(): void;
    stop(): void;
    private scan;
}
//# sourceMappingURL=directory.d.ts.map