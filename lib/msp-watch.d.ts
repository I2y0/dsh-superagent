import { Q as Trigger } from "./intake-BVQR9ONJ.js";
import { n as SourceKind, r as SourceContext, t as Localized } from "./kind-BWwRhRaX.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
//#region src/sources/msp.d.ts
declare const SOURCE = "msp";
declare const MspConfigSchema: z.ZodObject<{
  enabled: z.ZodDefault<z.ZodBoolean>;
  paths: z.ZodDefault<z.ZodArray<z.ZodObject<{
    path: z.ZodString;
  }, z.core.$strip>>>;
  nodeName: z.ZodDefault<z.ZodString>;
  humanPaths: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
type MspConfig = z.infer<typeof MspConfigSchema>;
/** The topic a signal belongs to: `file.created.C:\x\y.zip` → `file.created`. */
declare const topicOf: (path: string) => string;
/** Deterministic id so a bridge restart that replays a signal does not double-open a ticket. */
declare const mspTriggerId: (node: string, path: string, at: string, payload: unknown) => string;
/** Turns one bridge line into the domain's Trigger; exposed for tests. */
declare function mspTrigger(event: {
  node?: string;
  path?: string;
  at?: string;
  payload?: unknown;
  human?: boolean;
}, config: Pick<MspConfig, 'humanPaths'>): Trigger | undefined;
declare const mspKind: SourceKind<MspConfig>;
declare function runMsp(ctx: SourceContext, signal: AbortSignal): Promise<unknown>;
declare const name = "dsh-superagent-msp";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { type Localized, MspConfig, MspConfigSchema, SOURCE, apply, inject, mspKind, mspTrigger, mspTriggerId, name, runMsp, topicOf };