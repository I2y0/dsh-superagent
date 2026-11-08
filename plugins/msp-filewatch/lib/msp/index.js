/**
 * 公开出口。对外只暴露这些名字——内部目录结构可以动，import 路径不必跟着动。
 */
export { MSPNode } from "./node.js";
export { Manifest } from "./core/manifest.js";
export { SignalType, encodeSignal, decodeSignal, makeSignal } from "./core/signal.js";
export { ToolResult } from "./core/content.js";
export { isValidNodeId, isValidSignalPath, isValidToolName } from "./core/grammar.js";
export { patternMatches } from "./protocol/matcher.js";
export { FrameDecoder, frameMessage } from "./protocol/framing.js";
export { Protocol } from "./protocol/protocol.js";
export { TcpConnection, TcpTransport } from "./transport/tcp.js";
export { DirectoryDiscovery } from "./discovery/directory.js";
export { DirectoryPresence } from "./presence/directory.js";
//# sourceMappingURL=index.js.map