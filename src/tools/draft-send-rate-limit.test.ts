import {
	describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {GMAIL_RETRY} from '../utils/gmail-api.js';
import {registerAll} from './index.js';

/**
 * Attack round 1 (2026-11-24): a scheduled draft whose send stayed rate limited
 * lost its schedule, because the give-up error did not start with
 * "Gmail API error:", which draft_send reads as "Gmail answered, nothing sent".
 * This runs the REAL makeGmailApiCall with only fetch faked.
 */

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
const saved = {...GMAIL_RETRY};
const encode = (msg: string) => Buffer.from(msg, 'utf8').toString('base64url');
const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

let tools: Map<string, Handler>;

beforeEach(() => {
	GMAIL_RETRY.maxAttempts = 3;
	GMAIL_RETRY.baseDelayMs = 2;
	GMAIL_RETRY.maxDelayMs = 4;
	GMAIL_RETRY.budgetMs = 500;
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	tools = new Map();
	const server = {
		registerTool: vi.fn((name: string, _meta: unknown, handler: Handler) => {
			tools.set(name, handler);
		}),
	} as unknown as McpServer;
	registerAll(server, {token: 't'});
});

afterEach(() => {
	Object.assign(GMAIL_RETRY, saved);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('draft_send under sustained rate limiting', () => {
	it('keeps the draft scheduled when every send attempt is rate limited', async () => {
		const marker = new Date(Date.now() + (120 * 60_000)).toISOString();
		const raw = encode(`X-Scheduled-Send: ${marker}\r\nTo: a@example.com\r\nSubject: hi\r\n\r\nbody`);
		const puts: string[] = [];
		let sends = 0;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			const path = new URL(url).pathname.replace('/gmail/v1', '');
			const method = init?.method ?? 'GET';
			if (method === 'GET' && path === '/users/me/drafts/d1') {
				return json({id: 'd1', message: {id: 'm1', threadId: 't1', raw}});
			}

			if (method === 'PUT' && path === '/users/me/drafts/d1') {
				puts.push(decode((JSON.parse(init?.body as string) as {message: {raw: string}}).message.raw));
				return json({id: 'd1', message: {id: `m${puts.length + 1}`, threadId: 't1'}});
			}

			if (method === 'POST' && path === '/users/me/drafts/send') {
				sends += 1;
				return new Response('{"error":{"code":429}}', {status: 429, statusText: 'Too Many Requests'});
			}

			if (method === 'GET' && path === '/users/me/labels') {
				return json({labels: [{id: 'Label_9', name: 'Scheduled-Send'}]});
			}

			return json({});
		}));

		await expect(tools.get('draft_send')!({draftId: 'd1'})).rejects.toThrow(/still scheduled/);
		expect(sends, 'send was retried up to maxAttempts').toBe(3);
		expect(puts, 'strip then restore').toHaveLength(2);
		expect(puts[1], 'restore puts the original time back').toContain(`X-Scheduled-Send: ${new Date(marker).toISOString()}`);
	});
});
