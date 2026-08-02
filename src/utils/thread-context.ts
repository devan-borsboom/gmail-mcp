import {makeGmailApiCall} from './gmail-api.js';

/**
 * Recover threading headers from the thread itself.
 *
 * `message_send`/`draft_create` accept `references`, but nothing forces a
 * caller to supply it, and the caller is a language model. When it is omitted
 * the chain collapses to a single id — the exact defect that shipped replies
 * as new threads to a real customer. Rather than rely on prompt wording to
 * prevent a recurrence, look the value up server-side whenever a `threadId`
 * is supplied without it.
 *
 * Best-effort by design: any failure returns nothing and the caller falls back
 * to whatever it was given. A send must never fail because this lookup did.
 */

type ThreadMessage = {
	payload?: {
		headers?: {name?: string; value?: string}[];
	};
};

function header(msg: ThreadMessage, name: string): string | undefined {
	const wanted = name.toLowerCase();
	return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === wanted)?.value;
}

export type ThreadHeaders = {
	inReplyTo?: string;
	references?: string;
};

export async function fetchThreadHeaders(
	threadId: string,
	token: string,
	preferredParent?: string,
): Promise<ThreadHeaders> {
	try {
		const thread = await makeGmailApiCall(
			'GET',
			`/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`
			+ '&metadataHeaders=Message-Id&metadataHeaders=References',
			token,
		) as {messages?: ThreadMessage[]};

		const messages = thread.messages ?? [];
		if (messages.length === 0) {
			return {};
		}

		// Prefer the message the caller says it is replying to, so the chain we
		// inherit is that message's own history. Fall back to the newest.
		const wanted = preferredParent
			? preferredParent.replace(/^&lt;/i, '<').replace(/&gt;$/i, '>')
			: undefined;
		const preferred = wanted
			? messages.find((m) => header(m, 'Message-Id') === wanted)
			: undefined;
		const parent = preferred ?? messages.at(-1)!;

		const messageId = header(parent, 'Message-Id');
		const references = header(parent, 'References');

		return {
			...(messageId && {inReplyTo: messageId}),
			// The outgoing References is the parent's References plus the
			// parent's own Message-ID. buildThreadHeaders appends the latter,
			// so hand it only the inherited part.
			...(references && {references}),
		};
	} catch {
		return {};
	}
}
