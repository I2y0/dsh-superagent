/**
 * 4 字节大端长度前缀的分帧（传输层约定，与 msp-py TCPTransport 一致）。
 */
/** 4 字节大端长度前缀的流式解码器。push 任意分块，弹出完整帧。 */
export declare class FrameDecoder {
    private buf;
    push(chunk: Buffer): Buffer[];
}
export declare function frameMessage(data: Buffer | Uint8Array): Buffer;
//# sourceMappingURL=framing.d.ts.map