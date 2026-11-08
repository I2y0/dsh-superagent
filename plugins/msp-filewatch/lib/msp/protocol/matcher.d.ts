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
export declare function patternMatches(pattern: string, path: string): boolean;
//# sourceMappingURL=matcher.d.ts.map