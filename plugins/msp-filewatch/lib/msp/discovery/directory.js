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
import * as fs from "node:fs";
import * as path from "node:path";
/** 递归排序键的稳定序列化（对齐 Python `json.dumps(sort_keys=True)` 的用途）。 */
function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return "[" + value.map(stableStringify).join(",") + "]";
    const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",") + "}";
}
export class DirectoryDiscovery {
    known = new Map();
    pollTimer = null;
    nodesDir;
    selfId;
    staleAfterMs;
    pollIntervalMs;
    onAdd = () => { };
    onRemove = () => { };
    constructor(nodesDir, selfId, staleAfterMs = 30_000, pollIntervalMs = 1_000) {
        this.nodesDir = nodesDir;
        this.selfId = selfId;
        this.staleAfterMs = staleAfterMs;
        this.pollIntervalMs = pollIntervalMs;
    }
    /** 启动轮询。立即扫一次，不等第一个周期。 */
    start() {
        this.scan();
        if (!this.pollTimer) {
            this.pollTimer = setInterval(() => this.scan(), this.pollIntervalMs);
            this.pollTimer.unref?.();
        }
    }
    stop() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
    scan() {
        const current = new Set();
        let files;
        try {
            files = fs.readdirSync(this.nodesDir);
        }
        catch {
            return; // 目录不存在：什么都不做（对齐参考实现的静默）
        }
        const now = Date.now();
        for (const f of files) {
            if (!f.endsWith(".json"))
                continue;
            let decl;
            try {
                decl = JSON.parse(fs.readFileSync(path.join(this.nodesDir, f), "utf-8"));
            }
            catch {
                continue; // 原子替换的中间态 / 坏文件：跳过
            }
            const nodeId = decl.node_id;
            if (typeof nodeId !== "string" || nodeId === this.selfId)
                continue;
            const ep = decl.endpoint;
            const addr = ep?.address;
            if (!ep || !addr)
                continue;
            // 租约：无 timestamp 视为永不过期（手写/旧格式，对齐参考实现的兼容条款）
            const ts = decl.timestamp;
            if (typeof ts === "number" && now - ts * 1000 > this.staleAfterMs)
                continue;
            current.add(nodeId);
            const hash = stableStringify(decl);
            if (this.known.get(nodeId) === hash)
                continue;
            this.known.set(nodeId, hash);
            this.onAdd({
                transportType: String(ep.transport_type ?? "tcp"),
                host: String(addr.host ?? "127.0.0.1"),
                port: Number(addr.port ?? 0),
                nodeId,
            });
        }
        for (const nodeId of [...this.known.keys()]) {
            if (!current.has(nodeId)) {
                this.known.delete(nodeId);
                this.onRemove(nodeId);
            }
        }
    }
}
//# sourceMappingURL=directory.js.map