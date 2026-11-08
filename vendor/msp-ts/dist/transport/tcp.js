/**
 * TCP 传输 —— 与 msp-py 的 TCPTransport 线上兼容（4 字节大端长度前缀）。
 *
 * Node 单线程，没有 Python 那套 per-connection 线程与发送锁：
 * 读写各一条事件流，断开是一条 "close" 事件。这让协议层少掉一半机器。
 */
import * as net from "node:net";
import { FrameDecoder, frameMessage } from "../protocol/framing.js";
/** 一条已完成的连接（不分客户端/服务端，握手属于协议层）。 */
export class TcpConnection {
    decoder = new FrameDecoder();
    closed = false;
    sock;
    peerHost;
    onData = () => { };
    onClose = () => { };
    constructor(sock, peerHost) {
        this.sock = sock;
        this.peerHost = peerHost;
        sock.on("data", (chunk) => {
            let frames;
            try {
                frames = this.decoder.push(chunk);
            }
            catch (err) {
                this.close();
                return;
            }
            for (const f of frames)
                this.onData(f);
        });
        sock.on("error", () => this.close());
        sock.on("close", () => this.close());
    }
    get isClosed() {
        return this.closed;
    }
    send(frame) {
        if (this.closed)
            throw new Error("连接已关闭");
        try {
            this.sock.write(frameMessage(frame));
        }
        catch {
            this.close();
            throw new Error("连接已关闭");
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.sock.destroy();
        }
        catch {
            /* 已死 */
        }
        this.onClose();
    }
}
/** 监听 + 入站分发 + 主动拨号。 */
export class TcpTransport {
    server = null;
    acceptHandler = null;
    earlyConnections = [];
    /** 设置入站连接处理器；handler 到位前列抵达的连接会被缓存并补发。 */
    setAcceptHandler(cb) {
        this.acceptHandler = cb;
        for (const c of this.earlyConnections.splice(0))
            cb(c);
    }
    /** 开始监听（等 bind 完成）。port 0 = 动态分配；返回实际绑定的地址。 */
    async listen(opts = {}) {
        if (this.server)
            throw new Error("listen() 已调用");
        const server = net.createServer((sock) => {
            const conn = this.wrap(sock);
            if (this.acceptHandler)
                this.acceptHandler(conn);
            else
                this.earlyConnections.push(conn);
        });
        this.server = server;
        const host = opts.host ?? "127.0.0.1";
        const port = opts.port ?? 0;
        // Node 的 bind 是异步的：listen 返回后立刻 server.address() 会是 null，
        // 必须等 'listening' 事件（这是上一版「listen 失败」的根因）。
        await new Promise((resolve, reject) => {
            server.once("listening", () => resolve());
            server.once("error", (err) => reject(err));
            server.listen(port, host);
        });
        const addr = server.address();
        if (!addr)
            throw new Error("listen 失败");
        return { host: addr.address, port: addr.port };
    }
    wrap(sock) {
        const peer = sock.remoteAddress?.replace(/^::ffff:/, "") ?? "";
        return new TcpConnection(sock, peer);
    }
    /** 主动拨号并返回裸连接（握手是协议层的职责）。 */
    async connect(ep, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const sock = net.connect({ host: ep.host, port: ep.port });
            const timer = setTimeout(() => {
                sock.destroy();
                reject(new Error(`连接 ${ep.host}:${ep.port} 超时`));
            }, timeoutMs);
            sock.once("connect", () => {
                clearTimeout(timer);
                const peer = sock.remoteAddress?.replace(/^::ffff:/, "") ?? ep.host;
                resolve(new TcpConnection(sock, peer));
            });
            sock.once("error", (err) => {
                clearTimeout(timer);
                reject(new Error(`连接 ${ep.host}:${ep.port} 失败: ${err.message}`));
            });
        });
    }
    close() {
        for (const c of this.earlyConnections)
            c.close();
        this.earlyConnections.length = 0;
        if (this.server) {
            try {
                this.server.close();
            }
            catch {
                /* 已关 */
            }
            this.server = null;
        }
    }
}
//# sourceMappingURL=tcp.js.map