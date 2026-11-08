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
import { Manifest } from "./core/manifest.js";
import { Protocol } from "./protocol/protocol.js";
import { DirectoryDiscovery } from "./discovery/directory.js";
import { DirectoryPresence } from "./presence/directory.js";
import { TcpTransport } from "./transport/tcp.js";
export class MSPNode {
    nodeId;
    manifest = new Manifest();
    protocol;
    transport;
    opts;
    presence = null;
    discovery = null;
    started = false;
    constructor(nodeId, opts = {}) {
        this.nodeId = nodeId;
        this.opts = {
            nodesDir: opts.nodesDir ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.msp/nodes`,
            host: opts.host ?? "127.0.0.1",
            connectPolicy: opts.connectPolicy ?? "eager",
            port: opts.port,
        };
        this.manifest.patterns = ["msp/publish-subscribe", "msp/request-reply"];
        this.manifest.capabilities = ["pub", "sub", "req", "rep"];
        // 组装点：传输层在这里创建并注入协议层（协议层不认识 TCP）
        this.transport = new TcpTransport();
        this.protocol = new Protocol({
            nodeId, manifest: this.manifest, transport: this.transport,
        });
    }
    // ------------------------------------------------------------------
    // 声明能力（start 前后都可以；start 后会推送清单更新）
    // ------------------------------------------------------------------
    tool(name, description, handler, inputSchema) {
        this.protocol.tool(name, handler);
        this.manifest.addTool({ name, description, inputSchema: inputSchema ?? {} });
        if (this.started)
            this.protocol.pushManifest();
        return this;
    }
    declareSignal(path, description) {
        this.manifest.addSignal(path, { description });
        if (this.started)
            this.protocol.pushManifest();
        return this;
    }
    on(pattern, cb) {
        this.protocol.on(pattern, cb);
        return this;
    }
    onConnected(cb) {
        const prev = this.protocol.onPeerConnected;
        this.protocol.onPeerConnected = (p, m) => {
            prev(p, m);
            cb(p, m);
        };
        return this;
    }
    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------
    /** 监听 → 宣告 → 发现 →（eager）拨号已有邻居。返回绑定端点。 */
    async start() {
        if (this.started)
            throw new Error("start() 只能调用一次");
        this.started = true;
        const ep = await this.protocol.listenAndServe({
            host: this.opts.host,
            port: this.opts.port ?? 0,
        });
        this.presence = new DirectoryPresence(this.opts.nodesDir, this.nodeId);
        this.presence.announce({
            nodeId: this.nodeId,
            transportType: "tcp",
            host: ep.host,
            port: ep.port,
        });
        if (this.opts.connectPolicy === "eager") {
            this.discovery = new DirectoryDiscovery(this.opts.nodesDir, this.nodeId);
            // 注意是**赋值**：onAdd 是字段，写成 onAdd(cb) 只是调用那个空函数，
            // 回调永远不会生效（症状：发现正常，但从不自动拨号）。
            this.discovery.onAdd = (dep) => {
                if (dep.transportType !== "tcp")
                    return;
                // 非规范方向的拨号会被去重仲裁关掉，失败无害（对端那条规范连接会建立）
                void this.protocol.dial({ host: dep.host, port: dep.port });
            };
            this.discovery.start();
        }
        return ep;
    }
    stop() {
        this.discovery?.stop();
        this.presence?.withdraw();
        this.protocol.stop();
        this.started = false;
    }
    // ------------------------------------------------------------------
    // 操作
    // ------------------------------------------------------------------
    async call(peerId, tool, args = {}, timeoutMs = 5000) {
        return this.protocol.call(peerId, tool, args, timeoutMs);
    }
    publish(path, payload) {
        this.protocol.publish(path, payload);
    }
    connections() {
        return [...this.protocol.connections.keys()];
    }
    neighbors() {
        // 邻居 = 已连接 ∪ 已发现（对齐 Python 侧 neighbors() 的语义子集）
        return this.connections();
    }
    peerManifest(peerId) {
        return this.protocol.peerManifests.get(peerId);
    }
}
//# sourceMappingURL=node.js.map