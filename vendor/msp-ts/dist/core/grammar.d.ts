/**
 * 命名文法（对齐 msp-py 的 core/grammar.py）。
 *
 *   Node ID     ^[a-z0-9_-]+$
 *   Tool name   ^[a-z0-9_-]+$        ← 比 MCP 更严：无大写、无点号
 *   Signal path ^[a-z0-9_-]+(\.[a-z0-9_-]+)*$
 *
 * 点号是 path 的层级分隔符，绝不能出现在工具名里——网关把设备工具挂成
 * `<node>_<tool>` 而不是 `<node>.<tool>`，原因就在这里。
 */
export declare function isValidNodeId(value: unknown): boolean;
export declare function isValidToolName(value: unknown): boolean;
export declare function isValidSignalPath(value: unknown): boolean;
//# sourceMappingURL=grammar.d.ts.map