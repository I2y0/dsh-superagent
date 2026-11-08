/**
 * 协议层 —— 握手、连接去重、信号分发、reqid 关联、广播扇出、探活。
 *
 * 与 msp-py 的 MSPProtocol 逐条对齐，包括它最微妙的一条：
 *
 *   连接去重仲裁。两端同时拨号时会有两条 TCP；规范方向由 node_id 字典序决定
 *   ——较小一方作为 outbound。非规范方向那条在握手完成时被关闭
 *   （入站侧甚至不回 ACK，让拨号方立刻感知）。
 */
import type { Signal } from "../core/signal.ts";
import type { Manifest } from "../core/manifest.ts";
import { ToolResult } from "../core/content.ts";
import type { ConnectionLike, Endpoint, TransportLike } from "../transport/base.ts";
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;
export type SignalHandler = (sig: Signal) => void;
export interface ProtocolOptions {
    nodeId: string;
    manifest: Manifest;
    /** 传输层由外部注入：协议层不认识 TCP，只认识 ConnectionLike。 */
    transport: TransportLike;
    handshakeTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
}
export declare class Protocol {
    readonly nodeId: string;
    private readonly manifest;
    private readonly handshakeTimeout;
    private readonly heartbeatInterval;
    private readonly heartbeatTimeout;
    readonly connections: Map<string, ConnectionLike>;
    readonly peerManifests: Map<string, Record<string, unknown>>;
    private readonly lastSeen;
    private readonly pending;
    private readonly tools;
    private readonly handlers;
    private reqCounter;
    private stopped;
    private heartbeatTimer;
    private readonly connMeta;
    onPeerConnected: (peerId: string, manifest: Record<string, unknown>) => void;
    onPeerDisconnected: (peerId: string) => void;
    constructor(opts: ProtocolOptions);
    tool(name: string, handler: ToolHandler): void;
    on(pattern: string, cb: SignalHandler): void;
    /** 开始监听，返回绑定端点。入站分发在后台跑。 */
    listenAndServe(opts?: {
        host?: string;
        port?: number;
    }): Promise<Endpoint>;
    /** 主动拨号 + 出站握手。失败返回 null（不致命：对端可能也在拨我们）。 */
    dial(ep: Endpoint): Promise<string | null>;
    private handleInbound;
    private waitFrame;
    private handshakeOutbound;
    private handshakeInbound;
    /** 去重仲裁：返回本条连接是否保留。规范方向 = node_id 较小一方 outbound。 */
    private finishHandshake;
    private register;
    private dispatch;
    private runTool;
    send(peerId: string, sig: Signal): void;
    /** 调用对端工具。错误即值：任何失败都返回 ToolResult(error=...)，不抛异常。 */
    call(peerId: string, tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
    /** 广播：发给所有已连接对端（接收方本地 on() 过滤，无订阅表）。 */
    publish(path: string, payload: Record<string, unknown>): void;
    /** 清单变更后推送给所有对端。 */
    pushManifest(): void;
    private heartbeat;
    stop(): void;
}
//# sourceMappingURL=protocol.d.ts.map