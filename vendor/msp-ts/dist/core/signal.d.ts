/**
 * Signal —— 唯一的信封结构。
 *
 * 序列化契约（来自对 Python 参考实现的逐行核对）：**恒输出全部 8 个顶层字段**，
 * None 写成 null；读取时未知顶层键收进 extras 并原样回带。
 */
export declare const SignalType: {
    readonly HELLO: "hello";
    readonly ACK: "ack";
    readonly SIGNAL: "signal";
    readonly TOOL_CALL: "tool_call";
    readonly TOOL_RESULT: "tool_result";
    readonly MANIFEST_UPDATE: "manifest_update";
    readonly PING: "ping";
    readonly PONG: "pong";
    readonly ERROR: "error";
};
export type SignalTypeValue = (typeof SignalType)[keyof typeof SignalType];
/** MSP 的统一信号结构。extras 收留线上未知顶层键，编码时原样带回。 */
export interface Signal {
    type: string;
    source: string;
    pattern: string | null;
    target: string | null;
    path: string | null;
    reqid: string | null;
    payload: Record<string, unknown>;
    timestamp: number;
    extras: Record<string, unknown>;
}
export declare function makeSignal(type: string, source: string, opts?: {
    target?: string | null;
    path?: string | null;
    reqid?: string | null;
    payload?: Record<string, unknown>;
}): Signal;
/** 固定键序只为日志可读；JSON 解析方本不关心键序。 */
export declare function encodeSignal(sig: Signal): Buffer;
export declare function decodeSignal(data: Buffer | Uint8Array): Signal;
//# sourceMappingURL=signal.d.ts.map