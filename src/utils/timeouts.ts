/**
 * How long each call to Google may take before it is abandoned. Node's fetch
 * otherwise waits up to 5 minutes for a reply, so a stalled network (a
 * half-open socket after the Mac wakes) hung tool calls instead of failing
 * fast. Writes get longer, since an attachment upload is legitimately slow.
 * Mutable only so tests can shorten them.
 */
export const GOOGLE_TIMEOUTS = {
	tokenMs: 10_000,
	gmailReadMs: 60_000,
	gmailWriteMs: 120_000,
};
