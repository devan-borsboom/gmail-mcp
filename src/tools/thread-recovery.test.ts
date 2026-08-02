import {
	describe, it, expect, vi, beforeEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {registerAll} from './index.js';
import type {Config} from './types.js';

vi.mock('../utils/gmail-api.js', () => ({
	makeGmailApiCall: vi.fn(),
	GMAIL_API_BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
}));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const GRANDPARENT = '<CAG3MzU0NeBtJZeBh5S+1mut5uXK6176uQybvOHT6R-Zxya9t5w@mail.gmail.com>';
const PARENT = '<CAMpzVZ==w4J50t9U3rH5xN1-gP2_nOoZrrRoto0S8g-WngHFXg@mail.gmail.com>';

/**
 * The threading fix added a `references` parameter, but nothing forces a
 * caller to pass it and the caller is a language model. Omitting it collapsed
 * the chain back to a single id — the original defect. These cover the
 * server-side recovery that removes the caller from that decision, plus the
 * forward path, which previously emitted no threading headers at all.
 */
describe('threading recovered without caller cooperation', () => {
	let tools: Map<string, Handler>;

	function decodeRaw(raw: string): string {
		return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
	}

	function unfold(msg: string): string {
		const split = msg.indexOf('\r\n\r\n');
		return (split === -1 ? msg : msg.slice(0, split)).replace(/\r\n[ \t]+/g, ' ');
	}

	/** Last message body handed to the Gmail send/draft endpoint, decoded. */
	function lastSent(): string {
		const body = vi.mocked(makeGmailApiCall).mock.calls.at(-1)![3] as {
			raw?: string;
			message?: {raw: string};
		};
		return unfold(decodeRaw(body.raw ?? body.message!.raw));
	}

	beforeEach(() => {
		vi.mocked(makeGmailApiCall).mockReset();
		tools = new Map();
		const server = {
			registerTool: vi.fn((name: string, _meta: unknown, handler: Handler) => {
				tools.set(name, handler);
			}),
		} as unknown as McpServer;
		registerAll(server, {token: 'test-token'} as Config);
	});

	describe('message_send with threadId but no references', () => {
		beforeEach(() => {
			vi.mocked(makeGmailApiCall).mockImplementation(async (method, endpoint) => {
				if (method === 'GET' && endpoint.includes('/threads/')) {
					return {
						messages: [
							{payload: {headers: [{name: 'Message-Id', value: GRANDPARENT}]}},
							{
								payload: {
									headers: [
										{name: 'Message-Id', value: PARENT},
										{name: 'References', value: GRANDPARENT},
									],
								},
							},
						],
					};
				}

				return {id: 'm1', threadId: 't1'};
			});
		});

		it('recovers the full chain from the thread', async () => {
			await tools.get('message_send')!({
				to: 'corey@example.com', subject: 'Re: port', body: 'hi', threadId: 't1',
			});

			expect(lastSent()).toContain(`References: ${GRANDPARENT} ${PARENT}`);
			expect(lastSent()).toContain(`In-Reply-To: ${PARENT}`);
		});

		it('honours a caller-supplied inReplyTo when picking the parent', async () => {
			await tools.get('message_send')!({
				to: 'corey@example.com',
				subject: 'Re: port',
				body: 'hi',
				threadId: 't1',
				inReplyTo: GRANDPARENT,
			});

			expect(lastSent()).toContain(`In-Reply-To: ${GRANDPARENT}`);
		});

		it('does not look up the thread when references was supplied', async () => {
			await tools.get('message_send')!({
				to: 'corey@example.com',
				subject: 'Re: port',
				body: 'hi',
				threadId: 't1',
				inReplyTo: PARENT,
				references: GRANDPARENT,
			});

			const lookups = vi.mocked(makeGmailApiCall).mock.calls
				.filter(([method, endpoint]) => method === 'GET' && endpoint.includes('/threads/'));
			expect(lookups).toHaveLength(0);
		});
	});

	it('still sends when the thread lookup fails', async () => {
		vi.mocked(makeGmailApiCall).mockImplementation(async (method, endpoint) => {
			if (method === 'GET' && endpoint.includes('/threads/')) {
				throw new Error('Gmail API error: 404 Not Found');
			}

			return {id: 'm1', threadId: 't1'};
		});

		await expect(tools.get('message_send')!({
			to: 'corey@example.com', subject: 'Re: port', body: 'hi', threadId: 't1',
		})).resolves.toBeDefined();
	});

	it('message_forward carries the forwarded message identity', async () => {
		vi.mocked(makeGmailApiCall).mockImplementation(async (method) => {
			if (method === 'GET') {
				return {
					id: 'm1',
					threadId: 't1',
					payload: {
						mimeType: 'text/plain',
						headers: [
							{name: 'From', value: 'corey@example.com'},
							{name: 'To', value: 'devan@example.com'},
							{name: 'Date', value: 'Tue, 28 Jul 2026 11:41:40 -0400'},
							{name: 'Subject', value: 'RingCentral port'},
							{name: 'Message-Id', value: PARENT},
							{name: 'References', value: GRANDPARENT},
						],
						body: {data: Buffer.from('original body').toString('base64url')},
					},
				};
			}

			return {id: 'm2', threadId: 't2'};
		});

		await tools.get('message_forward')!({id: 'm1', to: 'levi@example.com'});

		const sent = lastSent();
		expect(sent).toContain(`In-Reply-To: ${PARENT}`);
		expect(sent).toContain(`References: ${GRANDPARENT} ${PARENT}`);
	});
});
