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

const PARENT = '<CAMpzVZ==w4J50t9U3rH5xN1-gP2_nOoZrrRoto0S8g-WngHFXg@mail.gmail.com>';
const GRANDPARENT = '<CAG3MzU0NeBtJZeBh5S+1mut5uXK6176uQybvOHT6R-Zxya9t5w@mail.gmail.com>';

/**
 * These assert the actual RFC 2822 bytes we hand to Gmail. The regression they
 * guard against shipped to a real customer: replies arrived as new threads
 * because In-Reply-To went out as `&lt;...&gt;` and References never carried
 * more than the immediate parent.
 */
describe('reply threading headers', () => {
	let tools: Map<string, Handler>;

	function decodeRaw(raw: string): string {
		return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
	}

	/**
	 * Join RFC 5322 folded continuation lines back onto their header line, so
	 * assertions can read a header as one logical value. Only the header block
	 * is touched; the body is left alone.
	 */
	function unfoldHeaders(msg: string): string {
		const split = msg.indexOf('\r\n\r\n');
		const headers = split === -1 ? msg : msg.slice(0, split);
		return headers.replace(/\r\n[ \t]+/g, ' ');
	}

	/** Run a tool and return the decoded RFC 2822 message it produced. */
	async function sentMessage(tool: string, args: Record<string, unknown>): Promise<string> {
		const mocked = vi.mocked(makeGmailApiCall);
		mocked.mockResolvedValue(tool === 'draft_create'
			? {id: 'd1', message: {id: 'm1', threadId: 't1'}}
			: {id: 'm1', threadId: 't1'});

		await tools.get(tool)!(args);

		const body = mocked.mock.calls.at(-1)![3] as {raw?: string; message?: {raw: string}};
		return decodeRaw(body.raw ?? body.message!.raw);
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

	const base = {to: 'corey@example.com', subject: 'Re: port', body: 'hi'};

	for (const tool of ['message_send', 'draft_create']) {
		describe(tool, () => {
			it('repairs HTML-escaped ids into valid angle brackets', async () => {
				const msg = await sentMessage(tool, {
					...base,
					inReplyTo: '&lt;CAMpzVZ==w4J50t9U3rH5xN1-gP2_nOoZrrRoto0S8g-WngHFXg@mail.gmail.com&gt;',
				});

				expect(msg).toContain(`In-Reply-To: ${PARENT}`);
				expect(msg).not.toContain('&lt;');
				expect(msg).not.toContain('&gt;');
			});

			it('accumulates the full References chain', async () => {
				const msg = await sentMessage(tool, {
					...base,
					inReplyTo: PARENT,
					references: GRANDPARENT,
				});

				expect(unfoldHeaders(msg)).toContain(`References: ${GRANDPARENT} ${PARENT}`);
			});

			it('does not duplicate a parent already in the chain', async () => {
				const msg = await sentMessage(tool, {
					...base,
					inReplyTo: PARENT,
					references: `${GRANDPARENT} ${PARENT}`,
				});

				const line = unfoldHeaders(msg).split('\r\n').find((l) => l.startsWith('References:'))!;
				expect(line).toBeDefined();
				expect(/CAMpzVZ/g.exec(line) && line.match(/CAMpzVZ/g)).toHaveLength(1);
			});

			it('omits threading headers entirely on a fresh message', async () => {
				const msg = await sentMessage(tool, base);
				expect(msg).not.toContain('In-Reply-To:');
				expect(msg).not.toContain('References:');
			});

			it('omits rather than emits a malformed header for unusable input', async () => {
				const msg = await sentMessage(tool, {...base, inReplyTo: 'not-a-message-id'});
				expect(msg).not.toContain('In-Reply-To:');
			});

			it('cannot be used to inject extra headers', async () => {
				const msg = await sentMessage(tool, {
					...base,
					inReplyTo: '<a@b.com>\r\nBcc: attacker@evil.com',
				});

				expect(msg).not.toContain('attacker@evil.com');
			});

			it('folds a long chain onto continuation lines that start with whitespace', async () => {
				const chain = Array.from({length: 10}, (_, i) => `<msg-${i}@mail.gmail.com>`).join(' ');
				const msg = await sentMessage(tool, {...base, inReplyTo: PARENT, references: chain});

				const lines = msg.split('\r\n');
				const start = lines.findIndex((l) => l.startsWith('References:'));
				expect(start).toBeGreaterThan(-1);
				expect(lines[start + 1].startsWith(' ')).toBe(true);
				// Unfolding restores every id, parent included.
				const unfolded = msg.slice(msg.indexOf('References:')).split('\r\n')
					.reduce<string[]>((acc, l) => (acc.length === 0 || l.startsWith(' ') ? [...acc, l.trim()] : acc), [])
					.join(' ');
				expect(unfolded).toContain(PARENT);
				expect(unfolded).toContain('<msg-9@mail.gmail.com>');
			});
		});
	}
});
