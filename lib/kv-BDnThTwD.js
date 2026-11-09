//#region src/infra/text.ts
/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter("zh", { granularity: "word" });
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
function wordCount(text) {
	let count = 0;
	for (const segment of words.segment(text)) if (segment.isWordLike) count++;
	return count;
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
function checkedImText(text) {
	const count = wordCount(text);
	if (count > 100) throw new Error(`IM message has ${count} words; maximum is 100. Rewrite as a short high-level update. Do not split it into multiple messages.`);
	return text;
}
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
/** Case-insensitive comparison for GitHub logins and repository names. */
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
//#endregion
//#region src/sources/host.ts
/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
const HEALTH_TEXT = {
	setupPending: "Waiting for the deployment check",
	sourceOff: "Off",
	repositoryUnset: "The GitHub Source names no repository yet",
	feishuCliUnset: "The Source is on, and its bot lark-cli is not set",
	feishuBotMissing: "Waiting for the Feishu bot",
	pollFailures: "{count} consecutive failed polls; last: {error}"
};
function health(state, code, values = {}) {
	return {
		state,
		detail: fill(HEALTH_TEXT[code], values),
		code,
		...Object.keys(values).length ? { values } : {}
	};
}
const sourceContext = (host, kind) => host.context(kind);
//#endregion
//#region src/kv.ts
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
const record = (key) => key;
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
function family(prefix, format = (...name) => name.join(":")) {
	return Object.assign((...name) => `${prefix}${format(...name)}`, { prefix });
}
const KV = {
	/** Store: current database schema version. */
	store: { schema: record("schema") },
	/** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
	settings: {
		revision: record("settings-revision"),
		block: family("settings-block-revision:"),
		version: family("settings-version:")
	},
	/** Prompts: current revision and saved prompt versions. */
	prompts: {
		revision: record("prompt-revision"),
		version: family("prompt-version:"),
		/** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
		builtIn: family("prompt-built-in:")
	},
	/** Runtime: the main Session's ID. */
	runtime: { masterId: record("master-id") },
	/** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
	sessions: { prompts: family("session-prompts:") },
	/** Schema 11 migration: legacy main-Session queues imported into the effect table. */
	queues: {
		relays: record("relay-queue"),
		unsubscribed: record("subscription-results"),
		prompts: record("prompt-notification"),
		settings: record("settings-notification")
	},
	/** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
	sources: { labels: family("source-labels:") },
	/**
	* nene-inbox Source: the `size:mtime` already delivered for each absolute file path. This is what makes a restart
	* safe in both directions — a letter that arrived while nothing was watching is still new (no record), and a letter
	* that was delivered is not sent again. Marking every file present at startup as handled lost the first kind silently.
	*/
	neneInbox: { delivered: family("nene-inbox-delivered:") },
	/**
	* GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
	* per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
	* counts reported CI changes so each produces a distinct Trigger ID).
	*/
	github: {
		since: record("github-since"),
		retries: record("github-retry"),
		cursor: family("github-cursor:"),
		stream: family("github-stream:"),
		branchCi: record("github-branch-ci"),
		ci: family("github-ci:")
	},
	/**
	* Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
	* to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
	*/
	feishu: {
		chats: record("feishu-chats"),
		history: family("feishu-history:"),
		topics: family("feishu-history-threads:"),
		seen: family("thread-seen:"),
		initialized: family("thread-initialized:")
	}
};
//#endregion
export { escapeRegExp as a, wordCount as c, checkedImText as i, health as n, fill as o, sourceContext as r, sameName as s, KV as t };
