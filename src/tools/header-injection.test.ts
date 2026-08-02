import {
	describe, it, expect, vi, beforeEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {registerAll} from './index.js';
import type {Config} from './types.js';

vi.mock('../utils/gmail-api.js', () => ({
	makeGmailApiCall: vi.fn(),
	GMAIL_API_BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
}));

type Parser = {parse: (args: unknown) => unknown};

type ToolCase = {
	tool: string;
	base: Record<string, unknown>;
	fields: string[];
};

/**
 * Header values are pushed as `Name: value` and joined with CRLF, so a newline
 * inside any caller-supplied header value appends arbitrary headers to the
 * message. The concrete failure: a subject of
 * `Quick question\r\nBcc: attacker@example.com` produced a real Bcc line on the
 * wire, blind-copying a message the user believed had one recipient.
 *
 * The threading headers were already guarded (see threading.test.ts); these
 * cover the address and subject fields, which were not.
 */
describe('header injection via caller-supplied header fields', () => {
	let schemas: Map<string, Parser>;

	/** Validate `args` against a tool's declared input schema. */
	function parseWith(tool: string, args: Record<string, unknown>): unknown {
		return schemas.get(tool)!.parse(args);
	}

	beforeEach(() => {
		schemas = new Map();
		const server = {
			registerTool: vi.fn((name: string, meta: {inputSchema: Parser}) => {
				schemas.set(name, meta.inputSchema);
			}),
		} as unknown as McpServer;
		registerAll(server, {token: 'test-token'} as Config);
	});

	const cases: ToolCase[] = [
		{
			tool: 'message_send',
			base: {to: 'corey@example.com', subject: 'Re: port', body: 'hi'},
			fields: ['to', 'subject', 'cc', 'bcc', 'from'],
		},
		{
			tool: 'draft_create',
			base: {to: 'corey@example.com', subject: 'Re: port', body: 'hi'},
			fields: ['to', 'subject', 'cc', 'bcc', 'from'],
		},
		{
			tool: 'draft_update',
			base: {draftId: 'd1'},
			fields: ['to', 'subject', 'cc', 'bcc', 'from'],
		},
		{
			tool: 'message_forward',
			base: {id: 'm1', to: 'corey@example.com'},
			fields: ['to', 'from'],
		},
	];

	for (const testCase of cases) {
		describe(testCase.tool, () => {
			it('accepts ordinary values', () => {
				expect(() => parseWith(testCase.tool, testCase.base)).not.toThrow();
			});

			it('rejects a CRLF-injected Bcc in every header field', () => {
				for (const field of testCase.fields) {
					expect(() => parseWith(testCase.tool, {
						...testCase.base,
						[field]: 'corey@example.com\r\nBcc: attacker@example.com',
					}), field).toThrow(/newline/i);
				}
			});

			it('rejects a bare LF in every header field', () => {
				for (const field of testCase.fields) {
					expect(() => parseWith(testCase.tool, {
						...testCase.base,
						[field]: 'corey@example.com\nBcc: attacker@example.com',
					}), field).toThrow(/newline/i);
				}
			});
		});
	}

	it('still allows newlines in the body, which are legitimate', () => {
		expect(() => parseWith('message_send', {
			to: 'corey@example.com',
			subject: 'Re: port',
			body: 'line one\r\nline two\r\n\r\nline three',
		})).not.toThrow();
	});
});
