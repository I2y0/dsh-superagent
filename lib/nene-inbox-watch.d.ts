import { n as SourceKind } from "./kind-BWwRhRaX.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
//#region src/sources/nene-inbox.d.ts
declare const SOURCE = "nene-inbox";
declare const NeneInboxConfigSchema: z.ZodObject<{
  dirs: z.ZodDefault<z.ZodArray<z.ZodObject<{
    path: z.ZodString;
    role: z.ZodString;
    extensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    recursive: z.ZodDefault<z.ZodBoolean>;
  }, z.core.$strict>>>;
  settleMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
type NeneInboxConfig = z.infer<typeof NeneInboxConfigSchema>;
/**
 * The signal path a file from `role` arrives on.
 *
 * The role is part of the path so that routing rules can tell mailboxes apart with `paths` alone: the rule layer matches
 * signal paths, never filesystem paths, and `file.**` still matches every role for rules that want them all.
 */
declare const signalPathOf: (role: string) => string;
/**
 * The Thread one file belongs to.
 *
 * One Thread per file, not per role: a Thread that already has a Ticket delivers later signals into that Ticket as
 * context instead of opening new work, so a shared Thread would make every letter after the first a follow-up of it.
 */
declare const threadOf: (role: string, name: string) => string;
declare const neneInboxKind: SourceKind<NeneInboxConfig>;
declare const name = "dsh-superagent-nene-inbox";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { NeneInboxConfig, NeneInboxConfigSchema, SOURCE, apply, inject, name, neneInboxKind, signalPathOf, threadOf };