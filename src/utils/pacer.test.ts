import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {makeGmailApiCall, GMAIL_RETRY} from './gmail-api.js';
import {
	GMAIL_PACE, acquireGmailSlot, resetGmailPacer, gmailPacerState,
} from './pacer.js';

/**
 * The pacer smooths bursts (dozens of helper agents reading one mailbox) into a
 * steady stream so Google's per-user limits are not tripped. It only ever
 * delays a call: nothing is refused, dropped or sent twice.
 */

const savedPace = {...GMAIL_PACE};
const savedRetry = {...GMAIL_RETRY};

const ok = (body: unknown = {ok: true}) => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
const tooMany = () => new Response('{"error":{"code":429,"message":"Too many requests"}}', {status: 429});

beforeEach(() => {
	Object.assign(GMAIL_PACE, savedPace);
	Object.assign(GMAIL_RETRY, savedRetry);
	resetGmailPacer();
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	Object.assign(GMAIL_PACE, savedPace);
	Object.assign(GMAIL_RETRY, savedRetry);
	resetGmailPacer();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('rate smoothing', () => {
	it('a burst of 30 calls starts the first 10 at once, then 5 per second', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.perSecond = 5;
		GMAIL_PACE.burst = 10;
		GMAIL_PACE.maxConcurrent = 1000;
		resetGmailPacer();

		const t0 = Date.now();
		const starts: number[] = [];
		vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
			starts.push(Date.now() - t0);
			return ok();
		}));
		const done = Array.from({length: 30}, async () => makeGmailApiCall('GET', '/users/me/messages', 't'));

		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(done);

		expect(starts).toHaveLength(30);
		for (let i = 0; i < 10; i++) {
			expect(starts[i], `call ${i} is inside the burst`).toBe(0);
		}

		for (let i = 10; i < 30; i++) {
			// Call i needs (i - 9) fresh tokens at 5 per second: 200 ms apiece.
			expect(starts[i], `call ${i} waits for its token`).toBeGreaterThanOrEqual(((i - 9) * 200) - 1);
			expect(starts[i], `call ${i} is not held longer than needed`).toBeLessThanOrEqual(((i - 9) * 200) + 5);
		}

		// Any one-second window holds at most burst + one second of refill.
		for (const s of starts) {
			expect(starts.filter((x) => x >= s && x < s + 1000).length).toBeLessThanOrEqual(GMAIL_PACE.burst + GMAIL_PACE.perSecond);
		}
	});

	it('a single call on an idle pacer starts with no wait', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn().mockResolvedValue(ok({a: 1}));
		vi.stubGlobal('fetch', fetchMock);

		// No timer is advanced: the call must finish on microtasks alone.
		await expect(makeGmailApiCall('GET', '/users/me/profile', 't')).resolves.toEqual({a: 1});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('calls are only delayed, never refused: 100 calls through a tight pacer all succeed', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.perSecond = 2;
		GMAIL_PACE.burst = 2;
		GMAIL_PACE.maxConcurrent = 2;
		resetGmailPacer();
		const fetchMock = vi.fn().mockImplementation(async () => ok({fine: true}));
		vi.stubGlobal('fetch', fetchMock);

		const results = Array.from({length: 100}, async () => makeGmailApiCall('GET', '/users/me/messages', 't'));
		await vi.advanceTimersByTimeAsync(120_000);
		const settled = await Promise.allSettled(results);

		expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(100);
		expect(fetchMock).toHaveBeenCalledTimes(100);
		expect(gmailPacerState()).toEqual({queued: 0, inFlight: 0});
	});
});

describe('concurrency and order', () => {
	it('never has more than maxConcurrent requests in flight', async () => {
		GMAIL_PACE.maxConcurrent = 3;
		GMAIL_PACE.perSecond = 10_000;
		GMAIL_PACE.burst = 10_000;
		resetGmailPacer();

		const live = {now: 0, peak: 0};
		const gates: (() => void)[] = [];
		vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
			live.now += 1;
			live.peak = Math.max(live.peak, live.now);
			await new Promise<void>((resolve) => {
				gates.push(resolve);
			});
			live.now -= 1;
			return ok();
		}));

		const calls = Array.from({length: 12}, async () => makeGmailApiCall('GET', '/users/me/messages', 't'));
		const drain = async () => {
			while (gates.length > 0 || gmailPacerState().queued > 0 || live.now > 0) {
				// eslint-disable-next-line no-await-in-loop
				await new Promise((resolve) => {
					setTimeout(resolve, 1);
				});
				gates.splice(0).forEach((g) => {
					g();
				});
			}
		};

		await drain();
		await Promise.all(calls);
		expect(live.peak).toBe(3);
	});

	it('serves waiters first in, first out', async () => {
		GMAIL_PACE.maxConcurrent = 1;
		GMAIL_PACE.perSecond = 10_000;
		GMAIL_PACE.burst = 10_000;
		resetGmailPacer();

		const order: number[] = [];
		const first = await acquireGmailSlot();
		const waiters = [1, 2, 3, 4, 5].map(async (n) => {
			const release = await acquireGmailSlot();
			order.push(n);
			release();
		});

		expect(gmailPacerState()).toEqual({queued: 5, inFlight: 1});
		first();
		await Promise.all(waiters);
		expect(order).toEqual([1, 2, 3, 4, 5]);
	});

	it('releasing twice frees only one slot', async () => {
		GMAIL_PACE.maxConcurrent = 2;
		resetGmailPacer();
		const a = await acquireGmailSlot();
		await acquireGmailSlot();
		a();
		a();
		expect(gmailPacerState().inFlight).toBe(1);
	});
});

describe('slots are always given back', () => {
	const failures: [string, () => Response | Promise<Response>][] = [
		['fetch throws a network error', () => {
			throw new Error('socket hang up');
		}],
		['fetch times out', () => {
			const e = new Error('t');
			e.name = 'TimeoutError';
			throw e;
		}],
		['Gmail answers 500', () => new Response('boom', {status: 500, statusText: 'Server Error'})],
		['Gmail answers 200 with unparseable JSON', () => new Response('{nope', {status: 200, headers: {'content-type': 'application/json'}})],
	];

	for (const [name, makeFailure] of failures) {
		it(`${name}: the slot is freed and later calls proceed`, async () => {
			GMAIL_PACE.maxConcurrent = 1;
			GMAIL_PACE.perSecond = 10_000;
			GMAIL_PACE.burst = 10_000;
			resetGmailPacer();
			const fetchMock = vi.fn()
				.mockImplementationOnce(makeFailure)
				.mockResolvedValue(ok({later: true}));
			vi.stubGlobal('fetch', fetchMock);

			const bad = makeGmailApiCall('POST', '/users/me/messages/send', 't', {raw: 'x'});
			const good = makeGmailApiCall('GET', '/users/me/profile', 't');
			await expect(bad).rejects.toThrow();
			await expect(good).resolves.toEqual({later: true});
			expect(gmailPacerState()).toEqual({queued: 0, inFlight: 0});
		});
	}

	it('a rate-limit retry does not hold its slot while it sleeps', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.maxConcurrent = 1;
		GMAIL_PACE.perSecond = 10_000;
		GMAIL_PACE.burst = 10_000;
		resetGmailPacer();
		GMAIL_RETRY.baseDelayMs = 1000;
		GMAIL_RETRY.maxDelayMs = 1000;
		GMAIL_RETRY.budgetMs = 30_000;

		const log: string[] = [];
		const fetchMock = vi.fn().mockImplementation(async (url: string) => {
			log.push(url.endsWith('/slow') ? 'A' : 'B');
			if (url.endsWith('/slow') && log.filter((x) => x === 'A').length === 1) {
				return tooMany();
			}

			return ok({done: true});
		});
		vi.stubGlobal('fetch', fetchMock);

		const a = makeGmailApiCall('GET', '/slow', 't');
		const b = makeGmailApiCall('GET', '/other', 't');
		await vi.advanceTimersByTimeAsync(10);

		// A got its 429 and is asleep. B ran at once even though maxConcurrent is 1.
		expect(log).toEqual(['A', 'B']);
		expect(gmailPacerState().inFlight).toBe(0);

		await vi.advanceTimersByTimeAsync(5000);
		await expect(a).resolves.toEqual({done: true});
		await expect(b).resolves.toEqual({done: true});
		expect(log).toEqual(['A', 'B', 'A']);
		expect(gmailPacerState()).toEqual({queued: 0, inFlight: 0});
	});

	it('the retry itself waits for a slot like any other call', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.maxConcurrent = 1;
		GMAIL_PACE.perSecond = 10_000;
		GMAIL_PACE.burst = 10_000;
		resetGmailPacer();
		GMAIL_RETRY.baseDelayMs = 10;
		GMAIL_RETRY.maxDelayMs = 10;
		GMAIL_RETRY.budgetMs = 30_000;

		const hold = await acquireGmailSlot();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(tooMany())
			.mockResolvedValueOnce(ok({again: true}));
		vi.stubGlobal('fetch', fetchMock);
		const call = makeGmailApiCall('GET', '/users/me/profile', 't');

		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchMock).not.toHaveBeenCalled();
		hold();
		await vi.advanceTimersByTimeAsync(1000);
		await expect(call).resolves.toEqual({again: true});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('environment overrides', () => {
	const load = async (env: Record<string, string | undefined>) => {
		vi.resetModules();
		const keys = ['GMAIL_PACE_PER_SEC', 'GMAIL_PACE_BURST', 'GMAIL_PACE_CONCURRENT'];
		const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
		for (const k of keys) {
			if (env[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = env[k];
			}
		}

		try {
			const {perSecond, burst, maxConcurrent} = (await import('./pacer.js')).GMAIL_PACE;
			return {perSecond, burst, maxConcurrent};
		} finally {
			for (const k of keys) {
				if (before[k] === undefined) {
					Reflect.deleteProperty(process.env, k);
				} else {
					process.env[k] = before[k];
				}
			}
		}
	};

	it('defaults are 5 per second, burst 10, 4 at once', async () => {
		expect(await load({})).toEqual({perSecond: 5, burst: 10, maxConcurrent: 4});
	});

	it('valid values are picked up', async () => {
		expect(await load({GMAIL_PACE_PER_SEC: '2.5', GMAIL_PACE_BURST: '3', GMAIL_PACE_CONCURRENT: '7'}))
			.toEqual({perSecond: 2.5, burst: 3, maxConcurrent: 7});
	});

	for (const garbage of ['abc', '', '0', '-4', 'NaN', 'Infinity']) {
		it(`garbage ${JSON.stringify(garbage)} falls back to the defaults`, async () => {
			expect(await load({GMAIL_PACE_PER_SEC: garbage, GMAIL_PACE_BURST: garbage, GMAIL_PACE_CONCURRENT: garbage}))
				.toEqual({perSecond: 5, burst: 10, maxConcurrent: 4});
		});
	}
});
