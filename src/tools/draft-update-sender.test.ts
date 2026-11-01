import {
	describe, it, expect, vi, beforeEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {registerAll} from './index.js';

/**
 * draft_update keeps the draft's current sender when `from` is omitted. The
 * PreToolUse signature gate cannot see that sender, so it guesses from the new
 * body (consulting marker = consulting draft). The server does know it, and
 * reports `senderWarning` exactly when the kept sender and the body disagree.
 */

vi.mock('../utils/gmail-api.js', () => ({
	makeGmailApiCall: vi.fn(),
	GMAIL_API_BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
}));

type Handler = (args: Record<string, unknown>) => Promise<{structuredContent?: Record<string, unknown>}>;

const encode = (msg: string) => Buffer.from(msg, 'utf8').toString('base64url');

const draftFrom = (from: string) => [
	`From: ${from}`,
	'To: client@example.com',
	'Subject: Proposal',
	'Content-Type: text/html; charset=utf-8',
	'',
	'<p>old</p>',
].join('\r\n');

const YC_BODY = '<p>Hi</p><p>Devan Borsboom | Co-owner<br>YetiConnect (+ FixYourFunnel)<br>(858) 800-4552</p>';
const CONSULT_BODY = '<p>Hi</p><p>Devan Borsboom<br>Borsboom Consulting | AI for Professional Practices<br>(403) 919-3151</p>';
const CONSULT = 'Devan Borsboom <devan@borsboomconsulting.com>';
const WORK = 'Devan Borsboom <devan@yeticonnect.com>';

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

async function update(args: Record<string, unknown>) {
	const result = await tools.get('draft_update')!({draftId: 'd1', ...args});
	return result.structuredContent?.senderWarning as string | undefined;
}

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

describe('draft_update with no from reports a kept sender that disagrees with the body', () => {
	it('consulting draft re-signed with the YetiConnect block warns', async () => {
		serve(draftFrom(CONSULT));
		const w = await update({body: YC_BODY});
		expect(w, 'consulting sender + YC body').toBeDefined();
		expect(w).toContain('devan@borsboomconsulting.com');
	});

	it('consulting draft re-written with no signature warns', async () => {
		serve(draftFrom(CONSULT));
		expect(await update({body: '<p>just text</p>'}), 'consulting sender + unsigned body').toBeDefined();
	});

	it('work draft re-signed with the consulting block warns', async () => {
		serve(draftFrom(WORK));
		const w = await update({body: CONSULT_BODY});
		expect(w, 'work sender + consulting body').toBeDefined();
		expect(w).toContain('devan@yeticonnect.com');
	});

	it('the consulting marker inside the quoted thread does not count', async () => {
		serve(draftFrom(WORK));
		expect(await update({body: `${YC_BODY}<div class="gmail_quote">${CONSULT_BODY}</div>`}), 'quoted consulting block').toBeUndefined();
	});

	it('consulting draft with a consulting body stays quiet', async () => {
		serve(draftFrom(CONSULT));
		expect(await update({body: CONSULT_BODY}), 'consulting + consulting').toBeUndefined();
	});

	it('work draft with a YetiConnect body stays quiet', async () => {
		serve(draftFrom(WORK));
		expect(await update({body: YC_BODY}), 'work + YC').toBeUndefined();
	});

	it('a passed from is left to the signature gate', async () => {
		serve(draftFrom(CONSULT));
		expect(await update({body: YC_BODY, from: WORK}), 'explicit from').toBeUndefined();
	});

	it('a header-only update stays quiet', async () => {
		serve(draftFrom(CONSULT));
		expect(await update({subject: 'New subject'}), 'no body').toBeUndefined();
	});
});
