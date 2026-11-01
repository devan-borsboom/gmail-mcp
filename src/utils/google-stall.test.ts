import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {mcpAuthFailure, proxyTokenRequest} from './auth-gate.js';
import {checkToken, clearTokenCache} from './token-cache.js';
import {makeGmailApiCall} from './gmail-api.js';
import {GOOGLE_TIMEOUTS} from './timeouts.js';

/**
 * Two ways a healthy token got treated as bad, or a call hung:
 * - tokeninfo answering 429 (rate limited) was cached as "invalid", so /mcp
 *   answered 401 and mcp-remote went to a browser login.
 * - no Google fetch had a timeout, so a stalled network (half-open socket after
 *   sleep) hung the tool call for undici's 5-minute default.
 */

const saved = {...GOOGLE_TIMEOUTS};

// A fetch that never answers, and only settles when its signal aborts.
const stalled = vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
	const signal = init?.signal;
	if (!signal) {
		return; // No signal: hangs for ever, which is the defect.
	}

	signal.addEventListener('abort', () => {
		reject(signal.reason as Error);
	});
}));

const settlesWithin = async <T>(p: Promise<T>, ms: number): Promise<{settled: boolean; value?: T; error?: unknown}> => Promise.race([
	p.then((value) => ({settled: true, value}), (error: unknown) => ({settled: true, error})),
	new Promise<{settled: boolean}>((resolve) => {
		setTimeout(() => {
			resolve({settled: false});
		}, ms);
	}),
]);

beforeEach(() => {
	clearTokenCache();
	GOOGLE_TIMEOUTS.tokenMs = 50;
	GOOGLE_TIMEOUTS.gmailReadMs = 50;
	GOOGLE_TIMEOUTS.gmailWriteMs = 80;
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	Object.assign(GOOGLE_TIMEOUTS, saved);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('tokeninfo rate limit', () => {
	it('a 429 from tokeninfo is "unreachable", not "invalid", and lets /mcp through', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"rate_limited"}', {status: 429})));
		expect(await checkToken('tok-429')).toBe('unreachable');
		expect(await mcpAuthFailure('tok-429b')).toBeUndefined();
	});

	it('a 429 is not cached: once Google answers, a valid token is valid', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', {status: 429})));
		await checkToken('tok-429c');
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({expires_in: 3600}), {status: 200})));
		expect(await checkToken('tok-429c')).toBe('valid');
	});
});

describe('stalled Google network', () => {
	it('tokeninfo gives up and reports "unreachable"', async () => {
		vi.stubGlobal('fetch', stalled);
		const r = await settlesWithin(checkToken('tok-stall'), 1000);
		expect(r.settled, 'checkToken settled').toBe(true);
		expect(r.value).toBe('unreachable');
	});

	it('the token exchange gives up and answers temporarily_unavailable', async () => {
		vi.stubGlobal('fetch', stalled);
		const r = await settlesWithin(proxyTokenRequest('https://oauth2.googleapis.com/token', new URLSearchParams({grant_type: 'refresh_token'})), 1000);
		expect(r.settled, 'proxyTokenRequest settled').toBe(true);
		expect((r.value as {status: number}).status).toBe(503);
	});

	it('a Gmail read gives up with an error naming the timeout', async () => {
		vi.stubGlobal('fetch', stalled);
		const r = await settlesWithin(makeGmailApiCall('GET', '/users/me/messages', 't'), 1000);
		expect(r.settled, 'Gmail GET settled').toBe(true);
		expect(String(r.error)).toMatch(/timed out/i);
	});

	it('a Gmail write gives up and warns it may have gone through', async () => {
		vi.stubGlobal('fetch', stalled);
		const r = await settlesWithin(makeGmailApiCall('POST', '/users/me/messages/send', 't', {raw: 'x'}), 1000);
		expect(r.settled, 'Gmail POST settled').toBe(true);
		expect(String(r.error)).toMatch(/may still have gone through/i);
	});
});
