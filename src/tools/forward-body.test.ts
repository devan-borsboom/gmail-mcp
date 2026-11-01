import {
	describe, it, expect, vi, beforeEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {registerAll} from './index.js';

/**
 * message_forward body handling: a single-part HTML email must forward as
 * HTML, an HTML+plain email must keep its HTML and inline images, and the
 * stranger-written From/To/Subject in the HTML forward header must be escaped.
 */

vi.mock('../utils/gmail-api.js', () => ({
	makeGmailApiCall: vi.fn(),
	GMAIL_API_BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
}));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const api = vi.mocked(makeGmailApiCall);
let tools: Map<string, Handler>;

function serve(payload: Record<string, unknown>) {
	api.mockImplementation(async (method: string, endpoint: string) => {
		if (method === 'GET' && endpoint.includes('/attachments/')) {
			return {data: b64('PNGDATA')};
		}

		if (method === 'GET') {
			return {id: 'm9', threadId: 'th9', payload};
		}

		return {id: 's1', threadId: 'th9'};
	});
}

const sent = () => {
	const call = api.mock.calls.find(([m, e]) => m === 'POST' && e.includes('/messages/send'))!;
	return Buffer.from((call[3] as {raw: string}).raw, 'base64url').toString();
};

const headers = [
	{name: 'From', value: 'Jane Roe <jane@example.com>'},
	{name: 'To', value: 'Devan <devan@example.com>'},
	{name: 'Subject', value: 'Invoice <b>42</b>'},
	{name: 'Date', value: 'Tue, 28 Jul 2026 11:41:40 -0400'},
];

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

describe('message_forward body', () => {
	it('forwards a single-part text/html email as HTML', async () => {
		serve({mimeType: 'text/html', headers, body: {data: b64('<p>Hello <b>there</b></p>')}});
		await tools.get('message_forward')!({id: 'm9', to: 'b@example.com'});
		const raw = sent();
		expect(raw).toContain('Content-Type: text/html');
		expect(raw).not.toContain('Content-Type: text/plain');
		expect(raw).toContain('<p>Hello <b>there</b></p>');
	});

	it('a single-part text/plain email still forwards as plain text', async () => {
		serve({mimeType: 'text/plain', headers, body: {data: b64('plain only')}});
		await tools.get('message_forward')!({id: 'm9', to: 'b@example.com'});
		expect(sent()).toContain('Content-Type: text/plain');
	});

	it('prefers the HTML of a plain+HTML email and keeps its inline image', async () => {
		serve({
			mimeType: 'multipart/related',
			headers,
			parts: [
				{
					mimeType: 'multipart/alternative', parts: [
						{mimeType: 'text/plain', body: {data: b64('plain version')}},
						{mimeType: 'text/html', body: {data: b64('<p>html <img src="cid:logo"></p>')}},
					],
				},
				{
					mimeType: 'image/png', filename: 'logo.png', headers: [{name: 'Content-ID', value: '<logo>'}], body: {attachmentId: 'A1'},
				},
			],
		});
		await tools.get('message_forward')!({id: 'm9', to: 'b@example.com'});
		const raw = sent();
		expect(raw, 'html body').toContain('<p>html <img src="cid:logo"></p>');
		expect(raw, 'image part').toContain('Content-Type: image/png');
		expect(raw, 'image cid').toContain('Content-ID: <logo>');
	});

	it('a plain-only email with an inline image still carries the image, as an attachment', async () => {
		serve({
			mimeType: 'multipart/related',
			headers,
			parts: [
				{mimeType: 'text/plain', body: {data: b64('plain only')}},
				{
					mimeType: 'image/png', filename: 'logo.png', headers: [{name: 'Content-ID', value: '<logo>'}], body: {attachmentId: 'A1'},
				},
			],
		});
		await tools.get('message_forward')!({id: 'm9', to: 'b@example.com'});
		const raw = sent();
		expect(raw).toContain('Content-Type: text/plain');
		expect(raw).toContain('Content-Type: image/png');
		expect(raw).toContain('filename="logo.png"');
	});

	it('escapes the original From, To and Subject in the HTML forward header', async () => {
		serve({mimeType: 'text/html', headers, body: {data: b64('<p>hi</p>')}});
		await tools.get('message_forward')!({id: 'm9', to: 'b@example.com', body: 'FYI <see below> & thanks'});
		const raw = sent();
		expect(raw, 'From address').toContain('From: Jane Roe &lt;jane@example.com&gt;<br>');
		expect(raw, 'To address').toContain('To: Devan &lt;devan@example.com&gt;');
		expect(raw, 'Subject markup').toContain('Subject: Invoice &lt;b&gt;42&lt;/b&gt;<br>');
		expect(raw, 'user note').toContain('FYI &lt;see below&gt; &amp; thanks');
	});
});
