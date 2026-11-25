// Gmail API configuration and utilities
import {GOOGLE_TIMEOUTS} from './timeouts.js';
import {
	GMAIL_PACE, GmailBusyError, GmailQueueTimeoutError, acquireGmailSlot,
} from './pacer.js';

export const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1';

// Common helper to create base headers
function createBaseHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		Accept: 'application/json',
	};
}

// Common helper to handle API errors
async function handleApiError(response: Response): Promise<never> {
	const errorText = await response.text();
	throw new Error(`Gmail API error: ${response.status} ${response.statusText} - ${errorText}`);
}

// Common helper to parse response based on content type
async function parseResponse(response: Response): Promise<unknown> {
	if (!response.ok) {
		await handleApiError(response);
	}

	const contentType = response.headers.get('content-type');

	if (contentType?.includes('application/json')) {
		const responseText = await response.text();

		if (!responseText.trim()) {
			return {success: true, message: 'Operation completed successfully'};
		}

		try {
			return JSON.parse(responseText);
		} catch (error) {
			throw new Error(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return (await response.text()) || 'Success';
}

/**
 * Google slows a project down by answering 429, or 403 with a rate-limit
 * reason, before it does any work. From Feb 1, 2027 Google holds AI agents
 * that call the REST API to its Standard tier quota, so this happens more.
 * A rejected request did nothing, so it is safe to wait and try again, for
 * writes as well as reads: Google's own guidance is exponential backoff.
 * Mutable only so tests can shorten the waits.
 */
export const GMAIL_RETRY = {
	maxAttempts: 5,
	baseDelayMs: 1000,
	maxDelayMs: 16_000,
	// Wall-clock limit for one call, retries and their waits included.
	budgetMs: 30_000,
};

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

function isRateLimited(status: number, bodyText: string): boolean {
	if (status === 429) {
		return true;
	}

	if (status !== 403) {
		return false;
	}

	try {
		const parsed = JSON.parse(bodyText) as {error?: {errors?: {reason?: string}[]; status?: string; details?: {reason?: string}[]}};
		const reasons = [
			...(parsed.error?.errors ?? []).map((e) => e.reason),
			...(parsed.error?.details ?? []).map((d) => d.reason),
		];
		return reasons.some((r) => typeof r === 'string' && (RATE_LIMIT_REASONS.has(r) || r === 'RATE_LIMIT_EXCEEDED'));
	} catch {
		return false;
	}
}

// Retry-After in seconds or as an HTTP date; undefined when absent or unusable.
function retryAfterMs(response: Response): number | undefined {
	const raw = response.headers?.get?.('retry-after');
	if (!raw) {
		return undefined;
	}

	const seconds = Number(raw);
	if (Number.isFinite(seconds)) {
		// A negative number is garbage, not a date: never hand it to Date.parse.
		return seconds >= 0 ? seconds * 1000 : undefined;
	}

	const when = Date.parse(raw);
	if (Number.isFinite(when)) {
		return Math.max(0, when - Date.now());
	}

	return undefined;
}

export type GmailCallOptions = {
	/**
	 * For a read that comes right before a write (thread headers before a reply,
	 * the original before a forward, the draft before a send). It gets the same
	 * priority and wait cap as the write, so a caller that gives up and retries
	 * cannot leave an abandoned call that still sends when its turn comes.
	 */
	urgent?: boolean;
};

const sleep = async (ms: number) => new Promise<void>((resolve) => {
	setTimeout(resolve, ms);
});

// Utility function to make authenticated API calls
export async function makeGmailApiCall(
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
	endpoint: string,
	accessToken: string,
	body?: unknown,
	options: GmailCallOptions = {},
) {
	const url = `${GMAIL_API_BASE_URL}${endpoint}`;
	const headers = createBaseHeaders(accessToken);

	if (body) {
		headers['Content-Type'] = 'application/json';
	}

	const isRead = method === 'GET';
	const timeoutMs = isRead ? GOOGLE_TIMEOUTS.gmailReadMs : GOOGLE_TIMEOUTS.gmailWriteMs;
	const serialized = body ? JSON.stringify(body) : undefined;

	let startedAt: number | undefined;
	for (let attempt = 1; ; attempt++) {
		// Every attempt, retries included, waits for a pacer slot. The slot is held
		// only while the request and its body are in flight, never during the
		// backoff sleep below. The budget clock starts once the first slot is won,
		// so time spent queued behind a burst does not eat the retry budget.
		// Writes (and urgent reads that prepare one) go ahead of reads and give up
		// (unsent) rather than wait behind a long burst, so a caller that times
		// out and retries cannot cause a double send.
		let release: () => void;
		try {
			// eslint-disable-next-line no-await-in-loop
			release = await (isRead && !options.urgent ? acquireGmailSlot() : acquireGmailSlot({priority: 'high', maxWaitMs: GMAIL_PACE.writeMaxWaitMs}));
		} catch (error) {
			if (error instanceof GmailQueueTimeoutError) {
				// The "Gmail API error:" prefix is what restoreAfterFailedSend reads as "did not send": true here.
				throw new GmailBusyError(`Gmail API error: 429 busy - ${error.message} (${method} ${endpoint.split('?')[0]}). Too many Gmail calls were queued on this inbox. It was not sent; retry in a minute.`);
			}

			throw error;
		}

		startedAt ??= Date.now();
		let limited: {response: Response; errorText: string};
		try {
			const fetchOptions: RequestInit = {
				method,
				headers,
				// A fresh timeout per attempt, started once the slot is held.
				signal: AbortSignal.timeout(timeoutMs),
			};

			if (serialized !== undefined) {
				fetchOptions.body = serialized;
			}

			let response: Response;
			try {
				// eslint-disable-next-line no-await-in-loop
				response = await fetch(url, fetchOptions);
			} catch (error) {
				if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
					// A write that timed out may still have reached Gmail, so say so
					// rather than inviting a blind retry that could send twice.
					throw new Error(`Gmail API request timed out after ${Math.round(timeoutMs / 1000)}s (${method} ${endpoint.split('?')[0]}).${isRead ? '' : ' It may still have gone through: check Gmail (Sent or Drafts) before retrying.'}`);
				}

				throw error;
			}

			if (response.ok) {
				// eslint-disable-next-line no-await-in-loop
				return await parseResponse(response);
			}

			// eslint-disable-next-line no-await-in-loop
			const errorText = await response.text();
			if (!isRateLimited(response.status, errorText)) {
				throw new Error(`Gmail API error: ${response.status} ${response.statusText} - ${errorText}`);
			}

			limited = {response, errorText};
		} finally {
			release();
		}

		const {response, errorText} = limited;
		// Never below one base delay (Google asks for at least a second before
		// the first retry), plus up to 50% random spread so parallel callers
		// do not all come back in the same instant.
		const backoff = Math.min(GMAIL_RETRY.maxDelayMs, GMAIL_RETRY.baseDelayMs * (2 ** (attempt - 1)));
		const asked = retryAfterMs(response);
		const floor = Math.max(GMAIL_RETRY.baseDelayMs, asked ?? backoff);
		const elapsed = Date.now() - startedAt;
		// The spread may not push a wait that fits the budget over it.
		const delay = Math.min(floor + (Math.random() * floor / 2), Math.max(floor, GMAIL_RETRY.budgetMs - elapsed));
		if (attempt >= GMAIL_RETRY.maxAttempts || elapsed + delay > GMAIL_RETRY.budgetMs) {
			// Keep the "Gmail API error: <status>" prefix: callers (draft_send's
			// schedule restore) treat that prefix as "Gmail answered, so it did not send".
			throw new Error(`Gmail API error: ${response.status} ${response.statusText} - rate limited by Google after ${attempt} attempt(s) over ${Math.round(elapsed / 1000)}s (${method} ${endpoint.split('?')[0]})${asked !== undefined && asked > GMAIL_RETRY.budgetMs ? `; Google asked to wait ${Math.round(asked / 1000)}s` : ''}. Google rejected it as rate limited, so it should not have ${isRead ? 'run' : 'changed or sent anything'}; retry later. - ${errorText}`);
		}

		console.error(`gmail-api: rate limited (${response.status}) on ${method} ${endpoint.split('?')[0]}, attempt ${attempt}; waiting ${Math.round(delay)} ms`);
		// eslint-disable-next-line no-await-in-loop
		await sleep(delay);
	}
}
