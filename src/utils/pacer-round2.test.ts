import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {makeGmailApiCall, GMAIL_RETRY} from './gmail-api.js';
import {
	GMAIL_PACE, acquireGmailSlot, resetGmailPacer, gmailPacerState,
} from './pacer.js';

const savedPace = {...GMAIL_PACE};
const savedRetry = {...GMAIL_RETRY};
const ok = () => new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}});

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
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.resetModules();
});

async function granted(options?: Parameters<typeof acquireGmailSlot>[0]): Promise<boolean> {
	let got = false;
	void acquireGmailSlot(options).then(() => {
		got = true;
	});
	await vi.advanceTimersByTimeAsync(1000);
	return got;
}

describe('settings that could stop every call', () => {
	for (const name of ['GMAIL_PACE_BURST', 'GMAIL_PACE_CONCURRENT']) {
		it(`${name}=0.5 in the environment still lets a call through`, async () => {
			vi.useFakeTimers();
			vi.stubEnv(name, '0.5');
			vi.resetModules();
			const fresh = await import('./pacer.js');
			expect(fresh.GMAIL_PACE.burst, `${name} burst`).toBeGreaterThanOrEqual(1);
			expect(fresh.GMAIL_PACE.maxConcurrent, `${name} concurrent`).toBeGreaterThanOrEqual(1);
			fresh.resetGmailPacer();
			let got = false;
			void fresh.acquireGmailSlot().then(() => {
				got = true;
			});
			await vi.advanceTimersByTimeAsync(1000);
			expect(got, `${name}: one call on an idle pacer`).toBe(true);
		});
	}

	for (const key of ['burst', 'maxConcurrent'] as const) {
		it(`GMAIL_PACE.${key} set to 0.5 at run time still lets a call through`, async () => {
			vi.useFakeTimers();
			GMAIL_PACE[key] = 0.5;
			resetGmailPacer();
			expect(await granted(), `${key}=0.5`).toBe(true);
		});
	}
});

describe('wall-clock steps', () => {
	it('a clock stepped back one hour does not hold up a lone call', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2027-02-01T12:00:00Z'));
		GMAIL_PACE.maxConcurrent = 1000;
		resetGmailPacer();
		const slots = await Promise.all(Array.from({length: GMAIL_PACE.burst}, async () => acquireGmailSlot()));
		for (const release of slots) {
			release();
		}

		vi.setSystemTime(new Date('2027-02-01T11:00:00Z'));
		expect(await granted()).toBe(true);
	});
});

describe('reset and stale slots', () => {
	it('a slot released after a reset does not raise the concurrency cap', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.maxConcurrent = 1;
		resetGmailPacer();
		const old = await acquireGmailSlot();
		resetGmailPacer();
		old();
		expect(gmailPacerState().inFlight).toBe(0);
		await acquireGmailSlot();
		let second = false;
		void acquireGmailSlot().then(() => {
			second = true;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(second, 'cap of 1 still holds').toBe(false);
	});
});

describe('writes versus a burst of reads', () => {
	it('a send goes ahead of a queued burst of reads', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.perSecond = 5;
		GMAIL_PACE.burst = 10;
		GMAIL_PACE.maxConcurrent = 1000;
		resetGmailPacer();
		const t0 = Date.now();
		let sentAt: number | undefined;
		vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
			if (init.method === 'POST') {
				sentAt = Date.now() - t0;
			}

			return ok();
		}));
		const reads = Array.from({length: 600}, async () => makeGmailApiCall('GET', '/users/me/messages', 't'));
		const send = makeGmailApiCall('POST', '/users/me/drafts/send', 't', {id: 'd1'});
		await vi.advanceTimersByTimeAsync(3000);
		await send;
		expect(sentAt, 'send starts within 3 s, not after 600 reads').toBeDefined();
		expect(sentAt!).toBeLessThan(3000);
		await vi.advanceTimersByTimeAsync(200_000);
		await Promise.all(reads);
	});

	it('a write that cannot get a turn in time fails unsent, with the prefix draft_send reads', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.perSecond = 1;
		GMAIL_PACE.burst = 1;
		GMAIL_PACE.maxConcurrent = 1000;
		GMAIL_PACE.writeMaxWaitMs = 5000;
		resetGmailPacer();
		const fetchMock = vi.fn().mockImplementation(async () => ok());
		vi.stubGlobal('fetch', fetchMock);
		// 50 writes in front of it need 50 s; each waits at most 5 s.
		const writes = Array.from({length: 50}, async (_, i) => makeGmailApiCall('POST', '/users/me/drafts/send', 't', {id: `d${i}`}).then(() => 'sent', (error: unknown) => (error as Error).message));
		await vi.advanceTimersByTimeAsync(60_000);
		const results = await Promise.all(writes);
		const failed = results.filter((r) => r !== 'sent');
		expect(failed.length, 'some writes gave up').toBeGreaterThan(0);
		for (const message of failed) {
			expect(message).toMatch(/^Gmail API error:/);
		}

		// Every write that reported "sent" reached Gmail exactly once, and no failed one did.
		expect(fetchMock).toHaveBeenCalledTimes(results.length - failed.length);
		expect(gmailPacerState().queued).toBe(0);
	});

	it('a gave-up write is not sent later when its turn would have come', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.perSecond = 1;
		GMAIL_PACE.burst = 1;
		GMAIL_PACE.maxConcurrent = 1000;
		GMAIL_PACE.writeMaxWaitMs = 2000;
		resetGmailPacer();
		const fetchMock = vi.fn().mockImplementation(async () => ok());
		vi.stubGlobal('fetch', fetchMock);
		const first = makeGmailApiCall('POST', '/x', 't', {a: 1});
		const second = makeGmailApiCall('POST', '/y', 't', {b: 1}).catch((error: unknown) => (error as Error).message);
		const third = makeGmailApiCall('POST', '/z', 't', {c: 1}).catch((error: unknown) => (error as Error).message);
		await vi.advanceTimersByTimeAsync(30_000);
		await first;
		await Promise.all([second, third]);
		const sentUrls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(sentUrls.filter((u) => u.endsWith('/y')).length + sentUrls.filter((u) => u.endsWith('/z')).length).toBeLessThanOrEqual(1);
		expect(fetchMock.mock.calls.length).toBe(1 + sentUrls.filter((u) => !u.endsWith('/x')).length);
		expect(gmailPacerState().queued).toBe(0);
	});
});

describe('hung connections', () => {
	it('four hung requests do not hold up a lone call for the whole timeout', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.maxConcurrent = 4;
		resetGmailPacer();
		for (let i = 0; i < 4; i++) {
			void acquireGmailSlot();
		}

		await vi.advanceTimersByTimeAsync(0);
		expect(gmailPacerState().inFlight).toBe(4);
		let got = false;
		void acquireGmailSlot().then(() => {
			got = true;
		});
		await vi.advanceTimersByTimeAsync(GMAIL_PACE.slotMaxHoldMs + 1000);
		expect(got, 'lone call after the hold limit').toBe(true);
	});
});

describe('retries are paced', () => {
	it('a rate-limit retry waits for a token like a first attempt', async () => {
		vi.useFakeTimers();
		GMAIL_PACE.burst = 1;
		GMAIL_PACE.perSecond = 0.2;
		GMAIL_PACE.maxConcurrent = 4;
		resetGmailPacer();
		GMAIL_RETRY.baseDelayMs = 1;
		GMAIL_RETRY.maxDelayMs = 2;
		GMAIL_RETRY.budgetMs = 60_000;
		const starts: number[] = [];
		const t0 = Date.now();
		vi.stubGlobal('fetch', vi.fn(async () => {
			starts.push(Date.now() - t0);
			return starts.length === 1
				? new Response('{}', {status: 429, headers: {'retry-after': '0'}})
				: new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}});
		}));
		const call = makeGmailApiCall('GET', '/x', 't');
		await vi.advanceTimersByTimeAsync(10_000);
		await call;
		expect(starts[1]! - starts[0]!, 'retry start gap in ms').toBeGreaterThanOrEqual(4900);
	});
});
