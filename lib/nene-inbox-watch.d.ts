import { $ as Trigger } from "./intake-DjKekxGR.js";
import { n as SourceContext, t as SourceKind } from "./kind-BtAABYtj.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
//#region src/sources/nene-inbox.d.ts
declare const SOURCE = "nene-inbox";
/** One watched directory, and what a file appearing in it means. */
declare const WatchedSchema: z.ZodObject<{
  path: z.ZodString;
  role: z.ZodString;
  extensions: z.ZodPipe<z.ZodDefault<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>, z.ZodTransform<string[], string | string[]>>;
  recursive: z.ZodDefault<z.ZodBoolean>;
  human: z.ZodPipe<z.ZodDefault<z.ZodUnion<readonly [z.ZodBoolean, z.ZodString]>>, z.ZodTransform<boolean, string | boolean>>;
  actor: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<string, string | undefined>>;
}, z.core.$strict>;
declare const NeneInboxConfigSchema: z.ZodObject<{
  dirs: z.ZodDefault<z.ZodArray<z.ZodObject<{
    path: z.ZodString;
    role: z.ZodString;
    extensions: z.ZodPipe<z.ZodDefault<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>, z.ZodTransform<string[], string | string[]>>;
    recursive: z.ZodDefault<z.ZodBoolean>;
    human: z.ZodPipe<z.ZodDefault<z.ZodUnion<readonly [z.ZodBoolean, z.ZodString]>>, z.ZodTransform<boolean, string | boolean>>;
    actor: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<string, string | undefined>>;
  }, z.core.$strict>>>;
  settleMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
type Watched = z.infer<typeof WatchedSchema>;
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
/**
 * One file as a Trigger.
 *
 * `meta.mspPath` and `meta.mspPayload` keep the names the routing rules and the Executor already read, so nothing
 * downstream changes while the transport does: the rule matches `file.created.<role>` and `sceneDirectory` finds the
 * scene from `payload.path`. The keys are renamed once the msp Source is gone.
 */
declare function buildTrigger(watched: Watched, name: string, absolutePath: string, bytes: number, at: string): Trigger;
/** Whether `name` is a file this entry wants: plain files only, matching one of `extensions` when any are given. */
declare function wanted(watched: Watched, name: string): boolean;
/**
 * Watches the configured directories and reports each file it settles on.
 *
 * Every accepted file becomes a Trigger and is ingested with `receive()`, which is where this Source's responsibility
 * ends: routing, tickets and workers all belong to the host.
 */
declare function watch(ctx: SourceContext, signal: AbortSignal): Promise<void>;
//#endregion
export { NeneInboxConfig, NeneInboxConfigSchema, SOURCE, Watched, apply, buildTrigger, inject, name, neneInboxKind, signalPathOf, threadOf, wanted, watch };