import {
	describe, it, expect, vi, beforeEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {registerAll} from './index.js';

/**
 * draft_update used to rebuild the draft from the passed fields alone. A
 * wording fix (draftId + body) wiped To, Subject, the reply headers and the
 * thread, turning a reply draft into an empty-recipient draft on a new thread.
 * These pin that every field not passed survives.
 */

vi.mock('../utils/gmail-api.js', () => ({
	makeGmailApiCall: vi.fn(),
	GMAIL_API_BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
}));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type Put = {id?: string; message: {raw: string; threadId?: string}};

const encode = (msg: string) => Buffer.from(msg, 'utf8').toString('base64url');
const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

const PARENT = '<parent@mail.gmail.com>';
const GRANDPARENT = '<grand@mail.gmail.com>';

const plainReply = [
	'From: Devan <devan@example.com>',
	'To: corey@example.com',
	'Cc: levi@example.com',
	'Subject: Re: RingCentral port',
	`In-Reply-To: ${PARENT}`,
	`References: ${GRANDPARENT}`,
	` ${PARENT}`,
	'Content-Type: text/plain; charset=utf-8',
	'',
	'old wording',
].join('\r\n');

const htmlReply = [
	'To: corey@example.com',
	'Subject: Re: RingCentral port',
	`In-Reply-To: ${PARENT}`,
	'Content-Type: text/html; charset=utf-8',
	'',
	'<p>old wording</p>',
].join('\r\n');

const withAttachment = [
	'To: corey@example.com',
	'Subject: Report',
	'MIME-Version: 1.0',
	'Content-Type: multipart/mixed; boundary="b1"',
	'',
	'--b1',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'see attached',
	'',
	'--b1',
	'Content-Type: application/pdf; name="report.pdf"',
	'Content-Transfer-Encoding: base64',
	'Content-Disposition: attachment; filename="report.pdf"',
	'',
	'UERGREFUQQ==',
	'',
	'--b1--',
].join('\r\n');

let tools: Map<string, Handler>;
const api = vi.mocked(makeGmailApiCall);

function serve(raw: string) {
	api.mockImplementation(async (method: string) => {
		if (method === 'GET') {
			return {id: 'd1', message: {id: 'm1', threadId: 'th1', raw: encode(raw)}};
		}

		return {id: 'd1', message: {id: 'm2', threadId: 'th1'}};
	});
}

const lastPut = (): Put => (api.mock.calls.find(([m]) => m === 'PUT')![3]) as Put;
const putRaw = () => decode(lastPut().message.raw);

beforeEach(() => {
	api.mockReset();
	tools = new Map();
	const server = {
		registerTool: vi.fn((name: string, _meta: unknown, handler: Handler) => {
			tools.set(name, handler);
		}),
	} as unknown as McpServer;
	registerAll(server, {token: 't'});
});

describe('draft_update keeps what was not passed', () => {
	it('body-only update keeps To, Cc, From, Subject and the reply headers', async () => {
		serve(plainReply);
		await tools.get('draft_update')!({draftId: 'd1', body: 'fixed wording'});
		const raw = putRaw();
		expect(raw, 'To').toContain('To: corey@example.com');
		expect(raw, 'Cc').toContain('Cc: levi@example.com');
		expect(raw, 'From').toContain('From: Devan <devan@example.com>');
		expect(raw, 'Subject').toContain('Subject: Re: RingCentral port');
		expect(raw, 'In-Reply-To').toContain(`In-Reply-To: ${PARENT}`);
		expect(raw, 'References').toContain(`References: ${GRANDPARENT}\r\n ${PARENT}`);
		expect(raw, 'new body').toContain('fixed wording');
		expect(raw, 'old body gone').not.toContain('old wording');
	});

	it('sends the draft\'s threadId in the PUT', async () => {
		serve(plainReply);
		await tools.get('draft_update')!({draftId: 'd1', body: 'fixed wording'});
		expect(lastPut().message.threadId).toBe('th1');
	});

	it('an HTML draft stays HTML when isHtml is omitted', async () => {
		serve(htmlReply);
		await tools.get('draft_update')!({draftId: 'd1', body: '<p>fixed</p>'});
		const raw = putRaw();
		expect(raw).toContain('Content-Type: text/html');
		expect(raw).not.toContain('text/plain');
	});

	it('isHtml: false still turns it to plain text', async () => {
		serve(htmlReply);
		await tools.get('draft_update')!({draftId: 'd1', body: 'fixed', isHtml: false});
		expect(putRaw()).toContain('Content-Type: text/plain');
	});

	it('a header-only update keeps the body and its Content-Type untouched', async () => {
		serve(htmlReply);
		await tools.get('draft_update')!({draftId: 'd1', to: 'new@example.com'});
		const raw = putRaw();
		expect(raw).toContain('To: new@example.com');
		expect(raw).not.toContain('corey@example.com');
		expect(raw).toContain('Content-Type: text/html; charset=utf-8\r\n\r\n<p>old wording</p>');
		expect(raw).toContain(`In-Reply-To: ${PARENT}`);
	});

	it('a passed header replaces the old one rather than duplicating it', async () => {
		serve(plainReply);
		await tools.get('draft_update')!({draftId: 'd1', subject: 'Re: new subject'});
		const raw = putRaw();
		expect(raw.match(/^Subject:/gim)).toHaveLength(1);
		expect(raw).toContain('Subject: Re: new subject');
	});

	it('a body-only update keeps the existing attachments', async () => {
		serve(withAttachment);
		await tools.get('draft_update')!({draftId: 'd1', body: 'new wording'});
		const raw = putRaw();
		expect(raw).toContain('filename="report.pdf"');
		expect(raw).toContain('UERGREFUQQ==');
		expect(raw).toContain('new wording');
		expect(raw).not.toContain('see attached');
		expect(raw.match(/^MIME-Version:/gim)).toHaveLength(1);
	});

	it('passed attachments replace the old ones and keep the old body', async () => {
		serve(withAttachment);
		await tools.get('draft_update')!({
			draftId: 'd1',
			attachments: [{filename: 'new.txt', mimeType: 'text/plain', content: Buffer.from('NEW').toString('base64')}],
		});
		const raw = putRaw();
		expect(raw).toContain('filename="new.txt"');
		expect(raw).not.toContain('report.pdf');
		expect(raw).toContain('see attached');
	});
});
