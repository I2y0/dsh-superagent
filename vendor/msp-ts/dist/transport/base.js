/**
 * 传输层契约 —— 协议层只认这两个接口，不认具体实现。
 *
 * TS 是结构类型，`TcpConnection` 不声明 implements 也能满足 `ConnectionLike`；
 * 显式留接口是为了 M5 的浏览器 WS 传输能对着契约实现，而不是对着 TCP 抄。
 */
export {};
//# sourceMappingURL=base.js.map