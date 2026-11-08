/**
 * MSPNode —— 用户入口（对齐 msp-py 的 MSPNode 形状，按 TS 习惯收敛）。
 *
 *   const node = new MSPNode("ts_b");
 *   node.tool("add", "加法", async ({ a, b }) => a + b);
 *   node.on("notify.**", (sig) => console.log(sig.path));
 *   await node.start();               // 监听 + 宣告 + 发现 + eager 拨号
 *   const r = await node.call("py_a", "py_echo", { msg: "hi" });
 *
 * 与 Python 版的有意差异：
 *   - schema 不做签名自省（TS 类型运行时不存在），inputSchema 显式传入；
 *   - 「等待」天然是 await——settle 在这里就是Promise，不需要条件变量。
 */
import { Manifest } from "./core/manifest.ts";
import type { ToolResult } from "./core/content.ts";
import { Protocol } from "./protocol/protocol.ts";
import type { ToolHandler } from "./protocol/protocol.ts";
import type { Endpoint } from "./transport/base.ts";
export interface MSPNodeOptions {
    nodesDir?: string;
    host?: string;
    port?: number;
    /** 发现即连（对齐 eager）；false = 只接受入站。 */
    connectPolicy?: "eager" | "lazy";
}
export declare class MSPNode {
    readonly nodeId: string;
    readonly manifest: Manifest;
    readonly protocol: Protocol;
    private readonly transport;
    private readonly opts;
    private presence;
    private discovery;
    private started;
    constructor(nodeId: string, opts?: MSPNodeOptions);
    tool(name: string, description: string, handler: ToolHandler, inputSchema?: Record<string, unknown>): this;
    declareSignal(path: string, description?: string): this;
    on(pattern: string, cb: (sig: Signal) => void): this;
    onConnected(cb: (peerId: string, manifest: Record<string, unknown>) => void): this;
    /** 监听 → 宣告 → 发现 →（eager）拨号已有邻居。返回绑定端点。 */
    start(): Promise<Endpoint>;
    stop(): void;
    call(peerId: string, tool: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
    publish(path: string, payload: Record<string, unknown>): void;
    connections(): string[];
    neighbors(): string[];
    peerManifest(peerId: string): Record<string, unknown> | undefined;
}
//# sourceMappingURL=node.d.ts.map