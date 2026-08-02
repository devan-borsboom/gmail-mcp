/**
 * Message-ID hygiene for reply threading.
 *
 * Two defects motivated this module (diagnosed 2026-08-02):
 *
 * 1. Callers sometimes hand us HTML-escaped ids, e.g. `&lt;abc@mail.gmail.com&gt;`.
 *    Written verbatim into In-Reply-To/References that is not a valid RFC 5322
 *    msg-id, so recipients' clients cannot match the parent and start a new
 *    thread. The sender never notices because Gmail's own threadId still groups
 *    the conversation locally.
 * 2. References previously carried only the immediate parent, never the
 *    accumulated chain, which strict clients treat as a broken thread.
 *
 * Both are handled here so every caller gets the same guarantees.
 */

/** Single pass of the entity replacements we actually see in the wild. */
function decodeOnce(value: string): string {
	return value
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;/g, '\'')
		.replace(/&apos;/gi, '\'')
		.replace(/&amp;/gi, '&');
}

/**
 * Decode HTML entities, repeating until stable so double-encoded input
 * (`&amp;lt;`) is also handled. Capped to avoid pathological input.
 */
export function decodeEntities(value: string): string {
	let current = value;
	for (let i = 0; i < 3; i++) {
		const next = decodeOnce(current);
		if (next === current) {
			break;
		}

		current = next;
	}

	return current;
}

/** A msg-id is `<local@domain>` with no whitespace or nested angle brackets. */
const MSGID_SHAPE = /^<[^<>\s]+@[^<>\s]+>$/;
const MSGID_GLOBAL = /<[^<>\s]+@[^<>\s]+>/g;

/**
 * Normalise a single Message-ID: unescape, trim, ensure angle brackets, and
 * validate the shape. Returns undefined for anything that is not a usable id,
 * so we omit the header entirely rather than emit a malformed one.
 */
export function normalizeMessageId(raw: string): string | undefined {
	let value = decodeEntities(raw).trim();
	if (!value) {
		return undefined;
	}

	if (!value.startsWith('<')) {
		value = `<${value}`;
	}

	if (!value.endsWith('>')) {
		value = `${value}>`;
	}

	return MSGID_SHAPE.test(value) ? value : undefined;
}

/**
 * Normalise a References header value into an ordered, de-duplicated list of
 * valid ids. Tolerates entity-escaped and whitespace-separated input.
 */
export function normalizeReferences(raw?: string): string[] {
	if (!raw) {
		return [];
	}

	const decoded = decodeEntities(raw);
	const candidates = decoded.match(MSGID_GLOBAL) ?? decoded.split(/\s+/);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const candidate of candidates) {
		const id = normalizeMessageId(candidate);
		if (id && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}

	return out;
}

/**
 * Build the reply headers for a message.
 *
 * Per RFC 5322 the outgoing References is the parent's References plus the
 * parent's Message-ID. Callers pass the parent's References as `references`;
 * if they omit it we still emit a single-element chain, which is no worse than
 * the previous behaviour.
 */
export function buildThreadHeaders(inReplyTo?: string, references?: string): {
	inReplyTo?: string;
	references?: string;
} {
	const parent = inReplyTo ? normalizeMessageId(inReplyTo) : undefined;
	const chain = normalizeReferences(references);
	if (parent && !chain.includes(parent)) {
		chain.push(parent);
	}

	return {
		...(parent && {inReplyTo: parent}),
		...(chain.length > 0 && {references: chain.join(' ')}),
	};
}

/**
 * Fold a long header across continuation lines (RFC 5322 section 2.2.3).
 * References grows unbounded on long threads, so this keeps lines under the
 * 78-character recommendation. The returned string embeds CRLFs and is meant
 * to be pushed as a single entry into a line array joined with CRLF.
 */
export function foldHeader(name: string, value: string): string {
	const tokens = value.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = `${name}:`;
	for (const token of tokens) {
		if (current !== `${name}:` && current.length + 1 + token.length > 76) {
			lines.push(current);
			current = ` ${token}`;
		} else {
			current += ` ${token}`;
		}
	}

	lines.push(current);
	return lines.join('\r\n');
}
