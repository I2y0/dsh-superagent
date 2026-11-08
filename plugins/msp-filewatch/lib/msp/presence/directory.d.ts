/**
 * 目录宣告 —— 把节点声明写进共享目录并周期续租（对齐 msp-py 的 DirectoryWrite）。
 *
 * timestamp 是租约：超过对端 staleAfter 未续租的声明会被视为过期，
 * 崩溃的节点因此自动从邻居表消失。写文件用 tmp + rename，避免读到半个 JSON。
 */
import type { DiscoveredEndpoint } from "../discovery/base.ts";
export declare class DirectoryPresence {
    private renewTimer;
    private readonly nodesDir;
    private readonly nodeId;
    private readonly renewIntervalMs;
    constructor(nodesDir: string, nodeId: string, renewIntervalMs?: number);
    private declarationPath;
    private writeOnce;
    announce(ep: DiscoveredEndpoint): void;
    withdraw(): void;
}
//# sourceMappingURL=directory.d.ts.map