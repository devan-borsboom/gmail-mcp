import {
	describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {GMAIL_PACE, resetGmailPacer} from '../utils/pacer.js';
import {registerAll} from './index.js';

/**
 * Attack round 2 (2026-11-24): only the final POST of a send had priority and
 * a wait cap. The read that comes BEFORE it (thread headers, the original to
 * forward, the draft) waited uncapped behind a burst of reads, so a client that
 * gave up and retried got the same email sent twice. These run the REAL tool
 * handlers and the REAL pacer with only fetch faked.
 */

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
const savedPace = {...GMAIL_PACE};
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

let tools: Map<string, Handler>;
const counter = {sends: 0};

beforeEach(() => {
	Object.assign(GMAIL_PACE, savedPace);
	GMAIL_PACE.maxConcurrent = 1000;
	resetGmailPacer();
	vi.useFakeTimers();
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	counter.sends = 0;
	tools = new Map();
	const server = {
		registerTool: vi.fn((name: string, _meta: unknown, handler: Handler) => {
			tools.set(name, handler);
		}),
	} as unknown as McpServer;
	registerAll(server, {token: 't'});
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname.replace('/gmail/v1', '');
		const method = init?.method ?? 'GET';
		if (method === 'POST' && (path === '/users/me/messages/send' || path === '/users/me/drafts/send' || path === '/users/me/drafts')) {
			counter.sends += 1;
			return json({id: 'd1', threadId: 't1', message: {id: 'm1', threadId: 't1'}});
		}

		if (path.startsWith('/users/me/threads/')) {
			return json({messages: [{id: 'p1', payload: {headers: [{name: 'Message-Id', value: '<p1@x>'}]}}]});
		}

		if (path.startsWith('/users/me/drafts/')) {
			return json({id: 'd1', message: {id: 'm1', threadId: 't1', raw: b64('To: a@example.com\r\nSubject: hi\r\n\r\nbody')}});
		}

		if (path.includes('/attachments/')) {
			return json({data: b64('FILEDATA')});
		}

		if (path.startsWith('/users/me/messages/')) {
			return json({
				id: 'm9',
				threadId: 'th9',
				payload: {
					mimeType: 'text/plain',
					headers: [
						{name: 'From', value: 'a@example.com'},
						{name: 'To', value: 'b@example.com'},
						{name: 'Subject', value: 's'},
						{name: 'Date', value: 'Tue, 28 Jul 2026 11:41:40 -0400'},
					],
					body: {data: b64('hello')},
					parts: path.endsWith('/mAtt')
						? [
							{mimeType: 'application/pdf', filename: 'f.pdf', body: {attachmentId: 'a1'}},
							{
								mimeType: 'image/png', filename: 'i.png', headers: [{name: 'Content-ID', value: '<i1>'}], body: {attachmentId: 'a2'},
							},
						]
						: undefined,
				},
			});
		}

		return json({ok: true});
	}));
});

afterEach(() => {
	Object.assign(GMAIL_PACE, savedPace);
	resetGmailPacer();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const cases: {name: string; tool?: string; args: Record<string, unknown>}[] = [
	{
		name: 'message_send', args: {
			to: 'a@example.com', subject: 'Re: hi', body: 'x', threadId: 'th1',
		},
	},
	{name: 'message_forward', args: {id: 'm9', to: 'b@example.com'}},
	{name: 'message_forward with an attachment and an inline image', tool: 'message_forward', args: {id: 'mAtt', to: 'b@example.com'}},
	{name: 'draft_send', args: {draftId: 'd1'}},
	{
		name: 'draft_create', args: {
			to: 'a@example.com', subject: 'Re: hi', body: 'x', threadId: 'th1',
		},
	},
];

const settle = (name: string, args: Record<string, unknown>) => {
	const tool = cases.find((c) => c.name === name)?.tool;
	const box: {result?: string} = {};
	void (tools.get(tool ?? name)!(args)).then(() => {
		box.result = 'ok';
	}, (error: unknown) => {
		box.result = error instanceof Error ? error.message : String(error);
	});
	return box;
};

describe('the read before a send does not wait behind a burst of reads', () => {
	for (const {name, args} of cases) {
		it(`${name}: settles within 25 s and sends once`, async () => {
			const burst = Array.from({length: 400}, async () => makeGmailApiCall('GET', '/users/me/messages', 't').catch(() => undefined));
			const call = settle(name, args);
			await vi.advanceTimersByTimeAsync(25_000);
			expect(call.result, `${name}: finished while 400 reads are still queued (about 80 s of backlog)`).toBe('ok');
			expect(counter.sends, `${name}: one send`).toBe(1);
			await vi.advanceTimersByTimeAsync(200_000);
			await Promise.all(burst);
			expect(counter.sends, `${name}: still one send after the backlog drains`).toBe(1);
		});
	}
});

describe('when even the prepared turn cannot be had, nothing is sent now or later', () => {
	for (const {name, args} of cases) {
		it(`${name}: fails busy within 25 s, never sends late, then a retry sends once`, async () => {
			const writes = Array.from({length: 400}, async () => makeGmailApiCall('POST', '/users/me/labels', 't', {name: 'x'}).catch(() => undefined));
			const first = settle(name, args);
			await vi.advanceTimersByTimeAsync(25_000);
			expect(first.result, `${name}: first call`).toMatch(/^Gmail API error: 429 busy/);
			await vi.advanceTimersByTimeAsync(200_000);
			await Promise.all(writes);
			expect(counter.sends, `${name}: the abandoned call sent nothing`).toBe(0);
			const retry = settle(name, args);
			await vi.advanceTimersByTimeAsync(5000);
			expect(retry.result, `${name}: retry`).toBe('ok');
			expect(counter.sends, `${name}: retry sent once`).toBe(1);
		});
	}
});

describe('a busy thread lookup is not swallowed as a missing thread', () => {
	it('message_send aborts instead of sending a reply with no thread headers', async () => {
		const writes = Array.from({length: 400}, async () => makeGmailApiCall('POST', '/users/me/labels', 't', {name: 'x'}).catch(() => undefined));
		const call = settle('message_send', {
			to: 'a@example.com', subject: 'Re: hi', body: 'x', threadId: 'th1',
		});
		await vi.advanceTimersByTimeAsync(25_000);
		expect(call.result, 'settled within 25 s').toMatch(/busy/);
		expect(counter.sends, 'nothing sent').toBe(0);
		await vi.advanceTimersByTimeAsync(200_000);
		await Promise.all(writes);
		expect(counter.sends, 'nothing sent later').toBe(0);
	});
});
