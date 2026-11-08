/**
 * Manifest —— 节点能力清单，握手时交换、变更时推送。
 */
export interface ToolSpec {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputTypes?: string[];
    annotations?: Record<string, unknown>;
}
/** 能力清单。版本号在每次变更时 +1，对端靠它判断「清单变没变」。 */
export declare class Manifest {
    version: number;
    patterns: string[];
    patternMetadata: Record<string, unknown>;
    capabilities: string[];
    signals: {
        path: string;
        schema?: Record<string, unknown>;
        description?: string;
    }[];
    tools: ToolSpec[];
    resources: unknown[];
    prompts: unknown[];
    clientCapabilities: {
        sampling: boolean;
        elicitation: boolean;
        roots: boolean;
    };
    addTool(spec: ToolSpec): void;
    addSignal(path: string, opts?: {
        schema?: Record<string, unknown>;
        description?: string;
    }): void;
    toDict(): Record<string, unknown>;
}
//# sourceMappingURL=manifest.d.ts.map