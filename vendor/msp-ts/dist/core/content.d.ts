/**
 * 工具结果值 —— 错误即值（对齐 msp-py 的 core/content.py）。
 */
/** 工具调用结果：错误即值，不抛异常（对齐 ToolResult 的语义）。 */
export declare class ToolResult {
    readonly content: unknown[];
    readonly structuredContent?: unknown;
    readonly error?: string;
    constructor(content: unknown[], structuredContent?: unknown, error?: string);
    get is_error(): boolean;
    unwrap(): unknown;
}
//# sourceMappingURL=content.d.ts.map