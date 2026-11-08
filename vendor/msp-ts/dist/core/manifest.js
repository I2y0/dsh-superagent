/**
 * Manifest —— 节点能力清单，握手时交换、变更时推送。
 */
/** 能力清单。版本号在每次变更时 +1，对端靠它判断「清单变没变」。 */
export class Manifest {
    version = 0;
    patterns = [];
    patternMetadata = {};
    capabilities = [];
    signals = [];
    tools = [];
    resources = [];
    prompts = [];
    clientCapabilities = { sampling: false, elicitation: false, roots: false };
    addTool(spec) {
        const existing = this.tools.findIndex((t) => t.name === spec.name);
        if (existing >= 0)
            this.tools[existing] = spec;
        else
            this.tools.push(spec);
        this.version += 1;
    }
    addSignal(path, opts = {}) {
        if (!this.signals.some((s) => s.path === path)) {
            this.signals.push({ path, schema: opts.schema, description: opts.description });
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
                ...(s.schema && Object.keys(s.schema).length > 0 ? { schema: s.schema } : {}),
                ...(s.description ? { description: s.description } : {}),
            })),
            tools: this.tools.map((t) => ({
                name: t.name,
                description: t.description ?? "",
                inputSchema: t.inputSchema ?? {},
                outputTypes: t.outputTypes ?? [],
                annotations: t.annotations ?? {},
            })),
            resources: [...this.resources],
            prompts: [...this.prompts],
            clientCapabilities: { ...this.clientCapabilities },
        };
    }
}
// ----------------------------------------------------------------------
//# sourceMappingURL=manifest.js.map