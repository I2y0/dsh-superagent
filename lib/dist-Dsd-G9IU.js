import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/core/manifest.js
/**
* Manifest —— 节点能力清单，握手时交换、变更时推送。
*/
/** 能力清单。版本号在每次变更时 +1，对端靠它判断「清单变没变」。 */
var Manifest = class {
	version = 0;
	patterns = [];
	patternMetadata = {};
	capabilities = [];
	signals = [];
	tools = [];
	resources = [];
	prompts = [];
	clientCapabilities = {
		sampling: false,
		elicitation: false,
		roots: false
	};
	addTool(spec) {
		const existing = this.tools.findIndex((t) => t.name === spec.name);
		if (existing >= 0) this.tools[existing] = spec;
		else this.tools.push(spec);
		this.version += 1;
	}
	addSignal(path, opts = {}) {
		if (!this.signals.some((s) => s.path === path)) {
			this.signals.push({
				path,
				schema: opts.schema,
				description: opts.description
			});
			this.version += 1;
		}
	}
	toDict() {
		return {
			version: this.version,
			patterns: [...this.patterns],
			patternMetadata: { ...this.patternMetadata },
			capabilities: [...this.capabilities].sort(),
			signals: this.signals.map((s) => ({
				path: s.path,
				...s.schema && Object.keys(s.schema).length > 0 ? { schema: s.schema } : {},
				...s.description ? { description: s.description } : {}
			})),
			tools: this.tools.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				inputSchema: t.inputSchema ?? {},
				outputTypes: t.outputTypes ?? [],
				annotations: t.annotations ?? {}
			})),
			resources: [...this.resources],
			prompts: [...this.prompts],
			clientCapabilities: { ...this.clientCapabilities }
		};
	}
};
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/core/signal.js
/**
* Signal —— 唯一的信封结构。
*
* 序列化契约（来自对 Python 参考实现的逐行核对）：**恒输出全部 8 个顶层字段**，
* None 写成 null；读取时未知顶层键收进 extras 并原样回带。
*/
const SignalType = {
	HELLO: "hello",
	ACK: "ack",
	SIGNAL: "signal",
	TOOL_CALL: "tool_call",
	TOOL_RESULT: "tool_result",
	MANIFEST_UPDATE: "manifest_update",
	PING: "ping",
	PONG: "pong",
	ERROR: "error"
};
function makeSignal(type, source, opts = {}) {
	return {
		type,
		source,
		pattern: null,
		target: opts.target ?? null,
		path: opts.path ?? null,
		reqid: opts.reqid ?? null,
		payload: opts.payload ?? {},
		timestamp: Date.now() / 1e3,
		extras: {}
	};
}
/** 固定键序只为日志可读；JSON 解析方本不关心键序。 */
function encodeSignal(sig) {
	const out = {
		type: sig.type,
		source: sig.source,
		pattern: sig.pattern,
		target: sig.target,
		path: sig.path,
		reqid: sig.reqid,
		payload: sig.payload,
		timestamp: sig.timestamp,
		...sig.extras
	};
	return Buffer.from(JSON.stringify(out), "utf-8");
}
function decodeSignal(data) {
	const raw = JSON.parse(Buffer.from(data).toString("utf-8"));
	if (typeof raw.type !== "string" || typeof raw.source !== "string") throw new Error("非法 Signal：缺少 type / source");
	const ts = typeof raw.timestamp === "number" ? raw.timestamp : Date.now() / 1e3;
	const payload = raw.payload !== null && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : {};
	const known = /* @__PURE__ */ new Set([
		"type",
		"source",
		"pattern",
		"target",
		"path",
		"reqid",
		"payload",
		"timestamp"
	]);
	const extras = {};
	for (const [k, v] of Object.entries(raw)) if (!known.has(k)) extras[k] = v;
	return {
		type: raw.type,
		source: raw.source,
		pattern: raw.pattern ?? null,
		target: raw.target ?? null,
		path: raw.path ?? null,
		reqid: raw.reqid ?? null,
		payload,
		timestamp: ts,
		extras
	};
}
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/core/content.js
/**
* 工具结果值 —— 错误即值（对齐 msp-py 的 core/content.py）。
*/
/** 工具调用结果：错误即值，不抛异常（对齐 ToolResult 的语义）。 */
var ToolResult = class {
	content;
	structuredContent;
	error;
	constructor(content, structuredContent, error) {
		this.content = content;
		this.structuredContent = structuredContent;
		this.error = error;
	}
	get is_error() {
		return typeof this.error === "string" && this.error.length > 0;
	}
	unwrap() {
		if (this.is_error) throw new Error(this.error);
		return this.structuredContent !== void 0 ? this.structuredContent : this.content;
	}
};
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/protocol/matcher.js
/**
* 通配符匹配（对齐 msp-py 的 protocol/matcher.py）：
*   精确      `ai.state` 只匹配自己
*   `*` 末尾  `ai.*` 恰好一段
*   `**` 末尾 `system.**` 零或多段（连 `system` 本身也匹配）
*/
/**
* 通配符匹配（与 `protocol/matcher.py` 同语义）：
*   精确        `ai.state` 只匹配 `ai.state`
*   `*` 末尾    `ai.*` 匹配 `ai.state`，不匹配 `ai.state.sub`（恰好一段）
*   `**` 末尾   `system.**` 匹配 `system` 及其下任意层（零或多段）
*/
function patternMatches(pattern, path) {
	if (pattern === "**" || pattern === "*") return true;
	if (pattern === path) return true;
	if (pattern.endsWith(".**")) {
		const base = pattern.slice(0, -3);
		return path === base || path.startsWith(base + ".");
	}
	if (pattern.endsWith(".*")) {
		const base = pattern.slice(0, -2);
		const rest = path.startsWith(base + ".") ? path.slice(base.length + 1) : null;
		return rest !== null && rest.length > 0 && !rest.includes(".");
	}
	return false;
}
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/protocol/protocol.js
/**
* 协议层 —— 握手、连接去重、信号分发、reqid 关联、广播扇出、探活。
*
* 与 msp-py 的 MSPProtocol 逐条对齐，包括它最微妙的一条：
*
*   连接去重仲裁。两端同时拨号时会有两条 TCP；规范方向由 node_id 字典序决定
*   ——较小一方作为 outbound。非规范方向那条在握手完成时被关闭
*   （入站侧甚至不回 ACK，让拨号方立刻感知）。
*/
var Protocol = class {
	nodeId;
	manifest;
	handshakeTimeout;
	heartbeatInterval;
	heartbeatTimeout;
	connections = /* @__PURE__ */ new Map();
	peerManifests = /* @__PURE__ */ new Map();
	lastSeen = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Map();
	tools = /* @__PURE__ */ new Map();
	handlers = [];
	reqCounter = 0;
	stopped = false;
	heartbeatTimer = null;
	connMeta = /* @__PURE__ */ new Map();
	onPeerConnected = () => {};
	onPeerDisconnected = () => {};
	constructor(opts) {
		this.nodeId = opts.nodeId;
		this.manifest = opts.manifest;
		this.transport = opts.transport;
		this.handshakeTimeout = opts.handshakeTimeoutMs ?? 1e4;
		this.heartbeatInterval = opts.heartbeatIntervalMs ?? 15e3;
		this.heartbeatTimeout = opts.heartbeatTimeoutMs ?? 45e3;
	}
	tool(name, handler) {
		this.tools.set(name, handler);
	}
	on(pattern, cb) {
		this.handlers.push({
			pattern,
			cb
		});
	}
	/** 开始监听，返回绑定端点。入站分发在后台跑。 */
	async listenAndServe(opts = {}) {
		const ep = await this.transport.listen(opts);
		this.transport.setAcceptHandler((conn) => void this.handleInbound(conn));
		this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatInterval);
		this.heartbeatTimer.unref?.();
		return ep;
	}
	/** 主动拨号 + 出站握手。失败返回 null（不致命：对端可能也在拨我们）。 */
	async dial(ep) {
		let conn;
		try {
			conn = await this.transport.connect(ep);
		} catch {
			return null;
		}
		try {
			return await this.handshakeOutbound(conn);
		} catch {
			conn.close();
			return null;
		}
	}
	async handleInbound(conn) {
		try {
			await this.handshakeInbound(conn);
		} catch {
			conn.close();
		}
	}
	waitFrame(conn, timeoutMs) {
		return new Promise((resolve, reject) => {
			const prev = conn.onData;
			const timer = setTimeout(() => {
				conn.onData = prev;
				reject(/* @__PURE__ */ new Error("握手超时"));
			}, timeoutMs);
			conn.onData = (frame) => {
				clearTimeout(timer);
				try {
					resolve(decodeSignal(frame));
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			};
		});
	}
	async handshakeOutbound(conn) {
		conn.send(encodeSignal(makeSignal(SignalType.HELLO, this.nodeId, { payload: { manifest: this.manifest.toDict() } })));
		let ack;
		for (;;) {
			const sig = await this.waitFrame(conn, this.handshakeTimeout);
			if (sig.type === SignalType.ACK) {
				ack = sig;
				break;
			}
			if (!this.connections.has(sig.source)) this.register(conn, sig.source, {});
			this.dispatch(sig.source, sig);
		}
		const peerId = ack.source;
		const peerManifest = ack.payload.manifest ?? {};
		if (!this.finishHandshake(conn, peerId, peerManifest, true)) throw new Error(`与 ${peerId} 的非规范连接被去重关闭`);
		return peerId;
	}
	async handshakeInbound(conn) {
		const hello = await this.waitFrame(conn, this.handshakeTimeout);
		if (hello.type !== SignalType.HELLO) throw new Error(`握手失败，收到 ${hello.type}`);
		const peerId = hello.source;
		const peerManifest = hello.payload.manifest ?? {};
		if (!this.finishHandshake(conn, peerId, peerManifest, false)) return;
		conn.send(encodeSignal(makeSignal(SignalType.ACK, this.nodeId, {
			target: peerId,
			payload: { manifest: this.manifest.toDict() }
		})));
	}
	/** 去重仲裁：返回本条连接是否保留。规范方向 = node_id 较小一方 outbound。 */
	finishHandshake(conn, peerId, peerManifest, outbound) {
		const existing = this.connections.get(peerId);
		if (!existing) {
			this.register(conn, peerId, peerManifest);
			return true;
		}
		if (existing === conn) {
			this.peerManifests.set(peerId, peerManifest);
			return true;
		}
		if (outbound === this.nodeId < peerId) {
			this.connMeta.delete(existing);
			existing.close();
			this.register(conn, peerId, peerManifest);
			return true;
		}
		conn.close();
		return false;
	}
	register(conn, peerId, peerManifest) {
		this.connections.set(peerId, conn);
		this.peerManifests.set(peerId, peerManifest);
		this.lastSeen.set(peerId, Date.now() / 1e3);
		this.connMeta.set(conn, { peerId });
		conn.onData = (frame) => {
			try {
				this.dispatch(peerId, decodeSignal(frame));
			} catch {}
		};
		conn.onClose = () => {
			if (this.connMeta.get(conn)?.peerId === peerId && this.connections.get(peerId) === conn) {
				this.connections.delete(peerId);
				this.peerManifests.delete(peerId);
				this.lastSeen.delete(peerId);
				this.connMeta.delete(conn);
				for (const [reqid, p] of [...this.pending]) if (reqid.startsWith(peerId + "|")) {
					clearTimeout(p.timer);
					this.pending.delete(reqid);
					p.resolve(new ToolResult([], void 0, "连接断开"));
				}
				this.onPeerDisconnected(peerId);
			}
		};
		this.onPeerConnected(peerId, peerManifest);
	}
	dispatch(peerId, msg) {
		this.lastSeen.set(peerId, Date.now() / 1e3);
		switch (msg.type) {
			case SignalType.SIGNAL:
				for (const h of this.handlers) if (msg.path && patternMatches(h.pattern, msg.path)) try {
					h.cb(msg);
				} catch {}
				break;
			case SignalType.TOOL_CALL:
				this.runTool(peerId, msg);
				break;
			case SignalType.TOOL_RESULT:
			case SignalType.ERROR: {
				if (!msg.reqid) break;
				const entry = this.pending.get(msg.reqid);
				if (!entry) break;
				this.pending.delete(msg.reqid);
				clearTimeout(entry.timer);
				if (msg.type === SignalType.TOOL_RESULT) entry.resolve(new ToolResult(msg.payload.content ?? [], msg.payload.structuredContent, typeof msg.payload.error === "string" ? msg.payload.error : void 0));
				else {
					const m = typeof msg.payload.message === "string" ? msg.payload.message : "对端报错";
					entry.resolve(new ToolResult([], void 0, m));
				}
				break;
			}
			case SignalType.MANIFEST_UPDATE:
				this.peerManifests.set(peerId, msg.payload.manifest ?? {});
				break;
			case SignalType.PING:
				this.send(peerId, makeSignal(SignalType.PONG, this.nodeId, { target: peerId }));
				break;
			case SignalType.PONG: break;
			default: this.send(peerId, makeSignal(SignalType.ERROR, this.nodeId, {
				target: peerId,
				reqid: msg.reqid,
				payload: {
					code: -32600,
					message: `未知信号类型: ${msg.type}`
				}
			}));
		}
	}
	async runTool(peerId, msg) {
		const name = msg.payload.tool;
		const args = msg.payload.args ?? {};
		let payload;
		const handler = this.tools.get(name);
		if (!handler) payload = {
			content: [],
			error: `未知工具: ${name}`
		};
		else try {
			payload = {
				content: [],
				structuredContent: await handler(args) ?? null
			};
		} catch (err) {
			payload = {
				content: [],
				error: err instanceof Error ? err.message : String(err)
			};
		}
		try {
			this.send(peerId, makeSignal(SignalType.TOOL_RESULT, this.nodeId, {
				target: peerId,
				reqid: msg.reqid,
				payload
			}));
		} catch {}
	}
	send(peerId, sig) {
		const conn = this.connections.get(peerId);
		if (!conn) throw new Error(`未连接: ${peerId}`);
		conn.send(encodeSignal(sig));
	}
	/** 调用对端工具。错误即值：任何失败都返回 ToolResult(error=...)，不抛异常。 */
	call(peerId, tool, args, timeoutMs = 5e3) {
		const conn = this.connections.get(peerId);
		if (!conn) return Promise.resolve(new ToolResult([], void 0, `未连接: ${peerId}`));
		const reqid = `${peerId}|ts-${this.reqCounter++}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(reqid);
				resolve(new ToolResult([], void 0, `调用 ${tool} 超时`));
			}, timeoutMs);
			this.pending.set(reqid, {
				resolve,
				timer
			});
			try {
				conn.send(encodeSignal(makeSignal(SignalType.TOOL_CALL, this.nodeId, {
					target: peerId,
					reqid,
					payload: {
						tool,
						args
					}
				})));
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(reqid);
				resolve(new ToolResult([], void 0, err instanceof Error ? err.message : String(err)));
			}
		});
	}
	/** 广播：发给所有已连接对端（接收方本地 on() 过滤，无订阅表）。 */
	publish(path, payload) {
		const sig = makeSignal(SignalType.SIGNAL, this.nodeId, {
			path,
			payload
		});
		for (const [, conn] of this.connections) try {
			conn.send(encodeSignal(sig));
		} catch {}
	}
	/** 清单变更后推送给所有对端。 */
	pushManifest() {
		const sig = makeSignal(SignalType.MANIFEST_UPDATE, this.nodeId, { payload: { manifest: this.manifest.toDict() } });
		for (const [, conn] of this.connections) try {
			conn.send(encodeSignal(sig));
		} catch {}
	}
	heartbeat() {
		if (this.stopped) return;
		const now = Date.now() / 1e3;
		for (const [peerId, ts] of [...this.lastSeen]) {
			if (now - ts > this.heartbeatTimeout / 1e3) {
				this.connections.get(peerId)?.close();
				continue;
			}
			try {
				this.send(peerId, makeSignal(SignalType.PING, this.nodeId, { target: peerId }));
			} catch {}
		}
	}
	stop() {
		this.stopped = true;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.resolve(new ToolResult([], void 0, "节点已停止"));
		}
		this.pending.clear();
		for (const [, conn] of this.connections) conn.close();
		this.connections.clear();
		this.transport.close();
	}
};
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/discovery/directory.js
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
/** 递归排序键的稳定序列化（对齐 Python `json.dumps(sort_keys=True)` 的用途）。 */
function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
	return "{" + Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",") + "}";
}
var DirectoryDiscovery = class {
	known = /* @__PURE__ */ new Map();
	pollTimer = null;
	nodesDir;
	selfId;
	staleAfterMs;
	pollIntervalMs;
	onAdd = () => {};
	onRemove = () => {};
	constructor(nodesDir, selfId, staleAfterMs = 3e4, pollIntervalMs = 1e3) {
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
		const current = /* @__PURE__ */ new Set();
		let files;
		try {
			files = fs.readdirSync(this.nodesDir);
		} catch {
			return;
		}
		const now = Date.now();
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			let decl;
			try {
				decl = JSON.parse(fs.readFileSync(path.join(this.nodesDir, f), "utf-8"));
			} catch {
				continue;
			}
			const nodeId = decl.node_id;
			if (typeof nodeId !== "string" || nodeId === this.selfId) continue;
			const ep = decl.endpoint;
			const addr = ep?.address;
			if (!ep || !addr) continue;
			const ts = decl.timestamp;
			if (typeof ts === "number" && now - ts * 1e3 > this.staleAfterMs) continue;
			current.add(nodeId);
			const hash = stableStringify(decl);
			if (this.known.get(nodeId) === hash) continue;
			this.known.set(nodeId, hash);
			this.onAdd({
				transportType: String(ep.transport_type ?? "tcp"),
				host: String(addr.host ?? "127.0.0.1"),
				port: Number(addr.port ?? 0),
				nodeId
			});
		}
		for (const nodeId of [...this.known.keys()]) if (!current.has(nodeId)) {
			this.known.delete(nodeId);
			this.onRemove(nodeId);
		}
	}
};
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/presence/directory.js
/**
* 目录宣告 —— 把节点声明写进共享目录并周期续租（对齐 msp-py 的 DirectoryWrite）。
*
* timestamp 是租约：超过对端 staleAfter 未续租的声明会被视为过期，
* 崩溃的节点因此自动从邻居表消失。写文件用 tmp + rename，避免读到半个 JSON。
*/
var DirectoryPresence = class {
	renewTimer = null;
	nodesDir;
	nodeId;
	renewIntervalMs;
	constructor(nodesDir, nodeId, renewIntervalMs = 5e3) {
		this.nodesDir = nodesDir;
		this.nodeId = nodeId;
		this.renewIntervalMs = renewIntervalMs;
	}
	declarationPath() {
		return path.join(this.nodesDir, `${this.nodeId}.json`);
	}
	writeOnce(ep) {
		const decl = {
			node_id: this.nodeId,
			endpoint: {
				transport_type: ep.transportType,
				address: {
					host: ep.host,
					port: ep.port
				}
			},
			timestamp: Date.now() / 1e3
		};
		const target = this.declarationPath();
		const tmp = target + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(decl, null, 2), "utf-8");
		fs.renameSync(tmp, target);
	}
	announce(ep) {
		fs.mkdirSync(this.nodesDir, { recursive: true });
		this.writeOnce(ep);
		if (!this.renewTimer) {
			this.renewTimer = setInterval(() => {
				try {
					this.writeOnce(ep);
				} catch {}
			}, this.renewIntervalMs);
			this.renewTimer.unref?.();
		}
	}
	withdraw() {
		if (this.renewTimer) {
			clearInterval(this.renewTimer);
			this.renewTimer = null;
		}
		try {
			fs.unlinkSync(this.declarationPath());
		} catch {}
	}
};
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/protocol/framing.js
/**
* 4 字节大端长度前缀的分帧（传输层约定，与 msp-py TCPTransport 一致）。
*/
/** 4 字节大端长度前缀的流式解码器。push 任意分块，弹出完整帧。 */
var FrameDecoder = class {
	buf = Buffer.alloc(0);
	push(chunk) {
		this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
		const frames = [];
		while (this.buf.length >= 4) {
			const len = this.buf.readUInt32BE(0);
			if (len > 67108864) throw new Error(`帧长度超限（${len} 字节），流已损坏`);
			if (this.buf.length < 4 + len) break;
			frames.push(this.buf.subarray(4, 4 + len));
			this.buf = this.buf.subarray(4 + len);
		}
		return frames;
	}
};
function frameMessage(data) {
	const body = Buffer.from(data);
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length, 0);
	return Buffer.concat([head, body]);
}
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/transport/tcp.js
/**
* TCP 传输 —— 与 msp-py 的 TCPTransport 线上兼容（4 字节大端长度前缀）。
*
* Node 单线程，没有 Python 那套 per-connection 线程与发送锁：
* 读写各一条事件流，断开是一条 "close" 事件。这让协议层少掉一半机器。
*/
/** 一条已完成的连接（不分客户端/服务端，握手属于协议层）。 */
var TcpConnection = class {
	decoder = new FrameDecoder();
	closed = false;
	sock;
	peerHost;
	onData = () => {};
	onClose = () => {};
	constructor(sock, peerHost) {
		this.sock = sock;
		this.peerHost = peerHost;
		sock.on("data", (chunk) => {
			let frames;
			try {
				frames = this.decoder.push(chunk);
			} catch (err) {
				this.close();
				return;
			}
			for (const f of frames) this.onData(f);
		});
		sock.on("error", () => this.close());
		sock.on("close", () => this.close());
	}
	get isClosed() {
		return this.closed;
	}
	send(frame) {
		if (this.closed) throw new Error("连接已关闭");
		try {
			this.sock.write(frameMessage(frame));
		} catch {
			this.close();
			throw new Error("连接已关闭");
		}
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		try {
			this.sock.destroy();
		} catch {}
		this.onClose();
	}
};
/** 监听 + 入站分发 + 主动拨号。 */
var TcpTransport = class {
	server = null;
	acceptHandler = null;
	earlyConnections = [];
	/** 设置入站连接处理器；handler 到位前列抵达的连接会被缓存并补发。 */
	setAcceptHandler(cb) {
		this.acceptHandler = cb;
		for (const c of this.earlyConnections.splice(0)) cb(c);
	}
	/** 开始监听（等 bind 完成）。port 0 = 动态分配；返回实际绑定的地址。 */
	async listen(opts = {}) {
		if (this.server) throw new Error("listen() 已调用");
		const server = net.createServer((sock) => {
			const conn = this.wrap(sock);
			if (this.acceptHandler) this.acceptHandler(conn);
			else this.earlyConnections.push(conn);
		});
		this.server = server;
		const host = opts.host ?? "127.0.0.1";
		const port = opts.port ?? 0;
		await new Promise((resolve, reject) => {
			server.once("listening", () => resolve());
			server.once("error", (err) => reject(err));
			server.listen(port, host);
		});
		const addr = server.address();
		if (!addr) throw new Error("listen 失败");
		return {
			host: addr.address,
			port: addr.port
		};
	}
	wrap(sock) {
		return new TcpConnection(sock, sock.remoteAddress?.replace(/^::ffff:/, "") ?? "");
	}
	/** 主动拨号并返回裸连接（握手是协议层的职责）。 */
	async connect(ep, timeoutMs = 5e3) {
		return new Promise((resolve, reject) => {
			const sock = net.connect({
				host: ep.host,
				port: ep.port
			});
			const timer = setTimeout(() => {
				sock.destroy();
				reject(/* @__PURE__ */ new Error(`连接 ${ep.host}:${ep.port} 超时`));
			}, timeoutMs);
			sock.once("connect", () => {
				clearTimeout(timer);
				const peer = sock.remoteAddress?.replace(/^::ffff:/, "") ?? ep.host;
				resolve(new TcpConnection(sock, peer));
			});
			sock.once("error", (err) => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error(`连接 ${ep.host}:${ep.port} 失败: ${err.message}`));
			});
		});
	}
	close() {
		for (const c of this.earlyConnections) c.close();
		this.earlyConnections.length = 0;
		if (this.server) {
			try {
				this.server.close();
			} catch {}
			this.server = null;
		}
	}
};
//#endregion
//#region node_modules/.pnpm/msp-ts@file+vendor+msp-ts/node_modules/msp-ts/dist/node.js
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
var MSPNode = class {
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
			port: opts.port
		};
		this.manifest.patterns = ["msp/publish-subscribe", "msp/request-reply"];
		this.manifest.capabilities = [
			"pub",
			"sub",
			"req",
			"rep"
		];
		this.transport = new TcpTransport();
		this.protocol = new Protocol({
			nodeId,
			manifest: this.manifest,
			transport: this.transport
		});
	}
	tool(name, description, handler, inputSchema) {
		this.protocol.tool(name, handler);
		this.manifest.addTool({
			name,
			description,
			inputSchema: inputSchema ?? {}
		});
		if (this.started) this.protocol.pushManifest();
		return this;
	}
	declareSignal(path, description) {
		this.manifest.addSignal(path, { description });
		if (this.started) this.protocol.pushManifest();
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
	/** 监听 → 宣告 → 发现 →（eager）拨号已有邻居。返回绑定端点。 */
	async start() {
		if (this.started) throw new Error("start() 只能调用一次");
		this.started = true;
		const ep = await this.protocol.listenAndServe({
			host: this.opts.host,
			port: this.opts.port ?? 0
		});
		this.presence = new DirectoryPresence(this.opts.nodesDir, this.nodeId);
		this.presence.announce({
			nodeId: this.nodeId,
			transportType: "tcp",
			host: ep.host,
			port: ep.port
		});
		if (this.opts.connectPolicy === "eager") {
			this.discovery = new DirectoryDiscovery(this.opts.nodesDir, this.nodeId);
			this.discovery.onAdd = (dep) => {
				if (dep.transportType !== "tcp") return;
				this.protocol.dial({
					host: dep.host,
					port: dep.port
				});
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
	async call(peerId, tool, args = {}, timeoutMs = 5e3) {
		return this.protocol.call(peerId, tool, args, timeoutMs);
	}
	publish(path, payload) {
		this.protocol.publish(path, payload);
	}
	connections() {
		return [...this.protocol.connections.keys()];
	}
	neighbors() {
		return this.connections();
	}
	peerManifest(peerId) {
		return this.protocol.peerManifests.get(peerId);
	}
};
//#endregion
export { MSPNode };
