/**
 * Paces Gmail API calls from this server (one server per inbox) so a burst,
 * such as dozens of helper agents reading a mailbox at once, is smoothed into
 * a steady stream instead of tripping Google's per-user rate limits.
 *
 * Two limits, both first-in first-out:
 * - at most `maxConcurrent` requests in flight at once;
 * - at most `perSecond` request starts per second, with `burst` allowed at once
 *   (a token bucket), so ordinary one-off calls never wait.
 *
 * A call only ever waits here; it is never refused. Values can be set per
 * server with GMAIL_PACE_PER_SEC, GMAIL_PACE_BURST and GMAIL_PACE_CONCURRENT.
 * Mutable so tests can shorten them.
 */

const envNumber = (name: string, fallback: number): number => {
	const raw = process.env[name];
	const value = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

// A whole number of at least 1: a fractional burst (0.5) could never hold the
// one token a call needs, and would stop every Gmail call on that inbox.
const envCount = (name: string, fallback: number): number => Math.max(1, Math.floor(envNumber(name, fallback)));

export const GMAIL_PACE = {
	perSecond: envNumber('GMAIL_PACE_PER_SEC', 5),
	burst: envCount('GMAIL_PACE_BURST', 10),
	maxConcurrent: envCount('GMAIL_PACE_CONCURRENT', 4),
	// A request that has not finished after this long gives its slot back (it
	// keeps running), so a few hung connections cannot hold up the whole inbox.
	slotMaxHoldMs: 10_000,
	// Longest a write may wait for its turn before it fails WITHOUT being sent.
	writeMaxWaitMs: 20_000,
};

// The values actually used, safe even if GMAIL_PACE was mutated to something odd.
const burstCap = (): number => Math.max(1, Math.floor(GMAIL_PACE.burst) || 1);
const concurrentCap = (): number => Math.max(1, Math.floor(GMAIL_PACE.maxConcurrent) || 1);
const ratePerSecond = (): number => (GMAIL_PACE.perSecond > 0 ? GMAIL_PACE.perSecond : 5);

/** A call gave up waiting for its turn. It was never sent to Gmail. */
export class GmailQueueTimeoutError extends Error {}

/**
 * What a caller sees when it gave up waiting for its turn on a busy inbox.
 * Nothing was sent. Its message keeps the "Gmail API error:" prefix that
 * draft_send's restore logic reads. Lives here, not in gmail-api.ts, so code
 * that tests with a faked gmail-api module still finds it.
 */
export class GmailBusyError extends Error {}

type Waiter = {grant: () => void; fail: (error: Error) => void; waitTimer?: ReturnType<typeof setTimeout>};

// Monotonic, so a wall-clock step (NTP, wake from sleep) cannot starve the queue.
const clock = (): number => performance.now();

let tokens = burstCap();
let lastRefill = clock();
let inFlight = 0;
let generation = 0;
const highQueue: Waiter[] = [];
const normalQueue: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

const queuedCount = (): number => highQueue.length + normalQueue.length;

function refill(now: number): void {
	const elapsedSec = Math.max(0, now - lastRefill) / 1000;
	lastRefill = now;
	tokens = Math.min(burstCap(), tokens + (elapsedSec * ratePerSecond()));
}

function nextWaiter(): Waiter | undefined {
	return highQueue.shift() ?? normalQueue.shift();
}

function pump(): void {
	// One wake-up timer at a time: a direct call (new waiter, release) replaces it.
	if (timer !== undefined) {
		clearTimeout(timer);
		timer = undefined;
	}

	refill(clock());
	while (queuedCount() > 0 && inFlight < concurrentCap() && tokens >= 1) {
		tokens -= 1;
		inFlight += 1;
		nextWaiter()!.grant();
	}

	// Still waiting only for a token (not for a free slot): wake when one is due.
	if (queuedCount() > 0 && inFlight < concurrentCap() && timer === undefined) {
		const waitMs = Math.max(1, Math.ceil(((1 - tokens) / ratePerSecond()) * 1000));
		timer = setTimeout(pump, waitMs);
	}
}

export type SlotOptions = {
	/** 'high' goes ahead of every 'normal' waiter (writes, so a send never queues behind reads). */
	priority?: 'high' | 'normal';
	/** Fail with GmailQueueTimeoutError, before anything is sent, if no turn comes in this long. */
	maxWaitMs?: number;
};

/**
 * Wait for a turn. Resolves to a release function, which must be called once
 * the request has finished (success or failure) to free the slot. A slot not
 * released within slotMaxHoldMs is freed anyway.
 */
export async function acquireGmailSlot(options: SlotOptions = {}): Promise<() => void> {
	const myGeneration = generation;
	await new Promise<void>((resolve, reject) => {
		const queue = options.priority === 'high' ? highQueue : normalQueue;
		const waiter: Waiter = {
			grant() {
				if (waiter.waitTimer !== undefined) {
					clearTimeout(waiter.waitTimer);
				}

				resolve();
			},
			fail: reject,
		};
		if (options.maxWaitMs !== undefined) {
			waiter.waitTimer = setTimeout(() => {
				const index = queue.indexOf(waiter);
				if (index >= 0) {
					queue.splice(index, 1);
					reject(new GmailQueueTimeoutError(`gave up waiting ${Math.round(options.maxWaitMs! / 1000)}s for a turn to call Gmail; nothing was sent`));
				}
			}, options.maxWaitMs);
		}

		queue.push(waiter);
		pump();
	});
	let released = false;
	const holdTimer = setTimeout(() => {
		release();
	}, GMAIL_PACE.slotMaxHoldMs);
	holdTimer.unref?.();
	function release(): void {
		if (released) {
			return;
		}

		released = true;
		clearTimeout(holdTimer);

		// A slot from before a reset belongs to state that no longer exists.
		if (myGeneration !== generation) {
			return;
		}

		inFlight -= 1;
		pump();
	}

	return release;
}

/** Test helper: forget all state and pick up the current GMAIL_PACE values. */
export function resetGmailPacer(): void {
	if (timer !== undefined) {
		clearTimeout(timer);
		timer = undefined;
	}

	for (const waiter of [...highQueue, ...normalQueue]) {
		if (waiter.waitTimer !== undefined) {
			clearTimeout(waiter.waitTimer);
		}
	}

	highQueue.length = 0;
	normalQueue.length = 0;
	generation += 1;
	inFlight = 0;
	tokens = burstCap();
	lastRefill = clock();
}

/** Test/diagnostic view of the pacer. */
export function gmailPacerState(): {queued: number; inFlight: number} {
	return {queued: queuedCount(), inFlight};
}
