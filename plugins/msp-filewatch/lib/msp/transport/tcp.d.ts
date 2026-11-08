/**
 * TCP 传输 —— 与 msp-py 的 TCPTransport 线上兼容（4 字节大端长度前缀）。
 *
 * Node 单线程，没有 Python 那套 per-connection 线程与发送锁：
 * 读写各一条事件流，断开是一条 "close" 事件。这让协议层少掉一半机器。
 */
import * as net from "node:net";
import type { ConnectionLike, Endpoint, TransportLike } from "./base.ts";
/** 一条已完成的连接（不分客户端/服务端，握手属于协议层）。 */
export declare class TcpConnection implements ConnectionLike {
    private decoder;
    private closed;
    private readonly sock;
    readonly peerHost: string;
    onData: (frame: Buffer) => void;
    onClose: () => void;
    constructor(sock: net.Socket, peerHost: string);
    get isClosed(): boolean;
    send(frame: Buffer): void;
    close(): void;
}
/** 监听 + 入站分发 + 主动拨号。 */
export declare class TcpTransport implements TransportLike {
    private server;
    private acceptHandler;
    private readonly earlyConnections;
    /** 设置入站连接处理器；handler 到位前列抵达的连接会被缓存并补发。 */
    setAcceptHandler(cb: (conn: TcpConnection) => void): void;
    /** 开始监听（等 bind 完成）。port 0 = 动态分配；返回实际绑定的地址。 */
    listen(opts?: {
        host?: string;
        port?: number;
    }): Promise<Endpoint>;
    private wrap;
    /** 主动拨号并返回裸连接（握手是协议层的职责）。 */
    connect(ep: Endpoint, timeoutMs?: number): Promise<TcpConnection>;
    close(): void;
}
//# sourceMappingURL=tcp.d.ts.map