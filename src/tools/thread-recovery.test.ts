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

	it('warns the caller when the thread lookup fails', async () => {
		vi.mocked(makeGmailApiCall).mockImplementation(async (method, endpoint) => {
			if (method === 'GET' && endpoint.includes('/threads/')) {
				throw new Error('Gmail API error: 429 Too Many Requests');
			}

			return {id: 'm1', threadId: 't1'};
		});

		const result = await tools.get('message_send')!({
			to: 'corey@example.com', subject: 'Re: port', body: 'hi', threadId: 't1',
		}) as {structuredContent: {threadingWarning?: string}};

		expect(result.structuredContent.threadingWarning).toMatch(/thread/i);
	});

	it('skips an unsent draft when choosing the parent', async () => {
		const DRAFT_ID = '<draft-never-sent@mail.gmail.com>';
		vi.mocked(makeGmailApiCall).mockImplementation(async (method, endpoint) => {
			if (method === 'GET' && endpoint.includes('/threads/')) {
				return {
					messages: [
						{labelIds: ['SENT'], payload: {headers: [{name: 'Message-ID', value: PARENT}]}},
						{labelIds: ['DRAFT'], payload: {headers: [{name: 'Message-ID', value: DRAFT_ID}]}},
					],
				};
			}

			return {id: 'm1', threadId: 't1'};
		});

		await tools.get('message_send')!({
			to: 'corey@example.com', subject: 'Re: port', body: 'hi', threadId: 't1',
		});

		expect(lastSent()).toContain(`In-Reply-To: ${PARENT}`);
		expect(lastSent()).not.toContain(DRAFT_ID);
	});

	it('treats an empty references string as absent and still recovers', async () => {
		vi.mocked(makeGmailApiCall).mockImplementation(async (method, endpoint) => {
			if (method === 'GET' && endpoint.includes('/threads/')) {
				return {
					messages: [
						{payload: {headers: [{name: 'Message-ID', value: GRANDPARENT}]}},
						{
							payload: {
								headers: [
									{name: 'Message-ID', value: PARENT},
									{name: 'References', value: GRANDPARENT},
								],
							},
						},
					],
				};
			}

			return {id: 'm1', threadId: 't1'};
		});

		await tools.get('message_send')!({
			to: 'corey@example.com', subject: 'Re: port', body: 'hi', threadId: 't1', references: '', inReplyTo: '',
		});

		expect(lastSent()).toContain(`References: ${GRANDPARENT} ${PARENT}`);
		expect(lastSent()).toContain(`In-Reply-To: ${PARENT}`);
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

	/**
	 * The forwarded subject is the one header value on any outgoing message
	 * that comes from a stranger rather than from the caller, so the input
	 * schema's newline guard never sees it.
	 */
	it('does not let a newline in a forwarded subject add a header', async () => {
		vi.mocked(makeGmailApiCall).mockImplementation(async (method) => {
			if (method === 'GET') {
				return {
					id: 'm1',
					threadId: 't1',
					payload: {
						mimeType: 'text/plain',
						headers: [
							{name: 'From', value: 'attacker@example.com'},
							{name: 'To', value: 'devan@example.com'},
							{name: 'Date', value: 'Tue, 28 Jul 2026 11:41:40 -0400'},
							{name: 'Subject', value: 'Invoice\r\nBcc: attacker@example.com'},
							{name: 'Message-Id', value: PARENT},
						],
						body: {data: Buffer.from('original body').toString('base64url')},
					},
				};
			}

			return {id: 'm2', threadId: 't2'};
		});

		await tools.get('message_forward')!({id: 'm1', to: 'levi@example.com'});

		expect(lastSent()).not.toMatch(/^Bcc:/m);
	});
});
