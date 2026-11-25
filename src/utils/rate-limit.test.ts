import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {makeGmailApiCall, GMAIL_RETRY} from './gmail-api.js';
import {GMAIL_PACE, resetGmailPacer} from './pacer.js';

/**
 * From Feb 1, 2027 Google holds AI agents calling the Gmail REST API to its
 * Standard tier quota and slows them with 429 (or 403 rate-limit reasons).
 * Before this change one 429 failed the tool call outright. Now a rate-limited
 * call waits and tries again, and only gives up after a bounded wait.
 */

const saved = {...GMAIL_RETRY};
const savedPace = {...GMAIL_PACE};

const ok = (body: unknown) => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
const tooMany = (headers: Record<string, string> = {}) => new Response('{"error":{"code":429,"message":"Too many requests"}}', {status: 429, headers});
const forbidden = (reason: string) => new Response(JSON.stringify({error: {code: 403, errors: [{reason}]}}), {status: 403, statusText: 'Forbidden'});

beforeEach(() => {
	// These tests time retries in milliseconds: keep the pacer out of their way.
	GMAIL_PACE.perSecond = 100_000;
	GMAIL_PACE.burst = 100_000;
	GMAIL_PACE.maxConcurrent = 1000;
	resetGmailPacer();
	GMAIL_RETRY.maxAttempts = 5;
	GMAIL_RETRY.baseDelayMs = 4;
	GMAIL_RETRY.maxDelayMs = 40;
	GMAIL_RETRY.budgetMs = 500;
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	Object.assign(GMAIL_RETRY, saved);
	Object.assign(GMAIL_PACE, savedPace);
	resetGmailPacer();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('rate-limited Gmail calls wait and retry', () => {
	it('a read that gets 429 once then succeeds returns the data', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(tooMany())
			.mockResolvedValueOnce(ok({messages: [{id: 'm1'}]}));
		vi.stubGlobal('fetch', fetchMock);

		await expect(makeGmailApiCall('GET', '/users/me/messages', 't')).resolves.toEqual({messages: [{id: 'm1'}]});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('a send that gets 429 twice goes out exactly once, with the same body each try', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(tooMany())
			.mockResolvedValueOnce(tooMany())
			.mockResolvedValueOnce(ok({id: 'sent-1'}));
		vi.stubGlobal('fetch', fetchMock);

		const body = {raw: 'abc'};
		await expect(makeGmailApiCall('POST', '/users/me/messages/send', 't', body)).resolves.toEqual({id: 'sent-1'});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		for (const call of fetchMock.mock.calls) {
			expect((call[1] as RequestInit).body).toBe(JSON.stringify(body));
		}
	});

	it('403 userRateLimitExceeded is retried', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(forbidden('userRateLimitExceeded'))
			.mockResolvedValueOnce(ok({}));
		vi.stubGlobal('fetch', fetchMock);

		await makeGmailApiCall('GET', '/users/me/labels', 't');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('403 rateLimitExceeded is retried', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(forbidden('rateLimitExceeded'))
			.mockResolvedValueOnce(ok({}));
		vi.stubGlobal('fetch', fetchMock);

		await makeGmailApiCall('POST', '/users/me/messages/x/modify', 't', {addLabelIds: ['A']});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('403 for a permission problem is NOT retried', async () => {
		const fetchMock = vi.fn().mockResolvedValue(forbidden('insufficientPermissions'));
		vi.stubGlobal('fetch', fetchMock);

		await expect(makeGmailApiCall('POST', '/users/me/settings/filters', 't', {})).rejects.toThrow('Gmail API error: 403');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('a 500 on a send is NOT retried (it may have gone through)', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('boom', {status: 500, statusText: 'Internal Server Error'}));
		vi.stubGlobal('fetch', fetchMock);

		await expect(makeGmailApiCall('POST', '/users/me/messages/send', 't', {raw: 'x'})).rejects.toThrow('Gmail API error: 500');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('a write that times out is NOT retried', async () => {
		const err = new Error('timed out');
		err.name = 'TimeoutError';
		const fetchMock = vi.fn().mockRejectedValue(err);
		vi.stubGlobal('fetch', fetchMock);

		await expect(makeGmailApiCall('POST', '/users/me/messages/send', 't', {raw: 'x'})).rejects.toThrow('may still have gone through');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('gives up after maxAttempts and says nothing was sent', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => tooMany());
		vi.stubGlobal('fetch', fetchMock);

		const failure = makeGmailApiCall('POST', '/users/me/messages/send', 't', {raw: 'x'});
		// The "Gmail API error:" prefix is what draft_send reads as "Gmail answered, it did not send".
		await expect(failure).rejects.toThrow(/^Gmail API error: 429 .*rate limited.*should not have changed or sent anything/s);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it('stops early when the wait budget would be exceeded', async () => {
		GMAIL_RETRY.budgetMs = 10;
		GMAIL_RETRY.baseDelayMs = 8;
		const fetchMock = vi.fn().mockImplementation(async () => tooMany());
		vi.stubGlobal('fetch', fetchMock);

		await expect(makeGmailApiCall('GET', '/users/me/messages', 't')).rejects.toThrow('rate limited');
		expect(fetchMock.mock.calls.length).toBeLessThan(5);
	});

	it('honours a short Retry-After (seconds)', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(tooMany({'retry-after': '0.06'}))
			.mockResolvedValueOnce(ok({}));
		vi.stubGlobal('fetch', fetchMock);

		const start = Date.now();
		await makeGmailApiCall('GET', '/users/me/messages', 't');
		expect(Date.now() - start).toBeGreaterThanOrEqual(55);
	});

	it('honours Retry-After given as an HTTP date', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(tooMany({'retry-after': new Date(Date.now() + 2000).toUTCString()}))
			.mockResolvedValueOnce(ok({}));
		vi.stubGlobal('fetch', fetchMock);
		GMAIL_RETRY.budgetMs = 5000;

		const start = Date.now();
		await makeGmailApiCall('GET', '/users/me/messages', 't');
		// toUTCString drops milliseconds, so the wait is 1-2 s, never the 4 ms base delay.
		expect(Date.now() - start).toBeGreaterThanOrEqual(900);
	});

	it('a Retry-After longer than the budget fails at once instead of hammering Google', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => tooMany({'retry-after': '3600'}));
		vi.stubGlobal('fetch', fetchMock);

		await expect(makeGmailApiCall('GET', '/users/me/messages', 't')).rejects.toThrow(/asked to wait 3600s/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	for (const bad of ['0', '-5', '0.001', 'Thu, 01 Jan 1970 00:00:00 GMT', 'soon']) {
		it(`Retry-After "${bad}" still waits at least the base delay`, async () => {
			GMAIL_RETRY.baseDelayMs = 30;
			GMAIL_RETRY.maxDelayMs = 30;
			const fetchMock = vi.fn()
				.mockResolvedValueOnce(tooMany({'retry-after': bad}))
				.mockResolvedValueOnce(ok({}));
			vi.stubGlobal('fetch', fetchMock);

			const start = Date.now();
			await makeGmailApiCall('GET', '/users/me/messages', 't');
			expect(Date.now() - start).toBeGreaterThanOrEqual(28);
		});
	}

	it('403 with google.rpc details reason RATE_LIMIT_EXCEEDED is retried', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({error: {code: 403, status: 'PERMISSION_DENIED', details: [{reason: 'RATE_LIMIT_EXCEEDED'}]}}), {status: 403}))
			.mockResolvedValueOnce(ok({}));
		vi.stubGlobal('fetch', fetchMock);

		await makeGmailApiCall('GET', '/users/me/messages', 't');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('403 with details reason userRateLimitExceeded is retried', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({error: {code: 403, details: [{reason: 'userRateLimitExceeded'}]}}), {status: 403}))
			.mockResolvedValueOnce(ok({}));
		vi.stubGlobal('fetch', fetchMock);

		await makeGmailApiCall('GET', '/users/me/messages', 't');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('parallel rate-limited calls spread their retries out', async () => {
		GMAIL_RETRY.baseDelayMs = 200;
		GMAIL_RETRY.maxDelayMs = 200;
		GMAIL_RETRY.budgetMs = 5000;
		const retryTimes: number[] = [];
		const seen = new Map<string, number>();
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			const n = (seen.get(url) ?? 0) + 1;
			seen.set(url, n);
			if (n === 1) {
				return tooMany();
			}

			retryTimes.push(Date.now());
			return ok({});
		}));

		await Promise.all(Array.from({length: 10}, async (_, i) => makeGmailApiCall('GET', `/users/me/messages/m${i}`, 't')));
		const spread = Math.max(...retryTimes) - Math.min(...retryTimes);
		expect(spread).toBeGreaterThanOrEqual(30);
	});

	it('the budget is wall clock: slow 429 answers count too', async () => {
		GMAIL_RETRY.budgetMs = 100;
		vi.stubGlobal('fetch', vi.fn(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 60);
			});
			return tooMany();
		}));

		const start = Date.now();
		await expect(makeGmailApiCall('GET', '/users/me/messages', 't')).rejects.toThrow('rate limited');
		expect(Date.now() - start).toBeLessThan(400);
	});

	it('a Retry-After that fits the budget is honoured even when the random spread would overshoot', async () => {
		GMAIL_RETRY.budgetMs = 300;
		GMAIL_RETRY.maxDelayMs = 300;
		vi.spyOn(Math, 'random').mockReturnValue(0.9);
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(tooMany({'retry-after': '0.21'}))
			.mockResolvedValueOnce(ok({done: true}));
		vi.stubGlobal('fetch', fetchMock);

		await expect(makeGmailApiCall('GET', '/users/me/messages', 't')).resolves.toEqual({done: true});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('uses a fresh timeout signal on every attempt', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(tooMany())
			.mockResolvedValueOnce(ok({}));
		vi.stubGlobal('fetch', fetchMock);

		await makeGmailApiCall('GET', '/users/me/messages', 't');
		const s1 = (fetchMock.mock.calls[0]![1] as RequestInit).signal;
		const s2 = (fetchMock.mock.calls[1]![1] as RequestInit).signal;
		expect(s1).toBeDefined();
		expect(s2).not.toBe(s1);
	});
});
