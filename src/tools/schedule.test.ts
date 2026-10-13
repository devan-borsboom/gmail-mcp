import {
	describe, it, expect, vi, beforeEach,
} from 'vitest';
import {type McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {parseSendAt, setScheduleMarker, readScheduleMarker} from '../utils/schedule.js';
import {registerAll} from './index.js';
import type {Config} from './types.js';

vi.mock('../utils/gmail-api.js', () => ({
	makeGmailApiCall: vi.fn(),
	GMAIL_API_BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
}));

type Handler = (args: Record<string, unknown>) => Promise<{structuredContent: Record<string, unknown>}>;
type Call = [string, string, string, Record<string, unknown> | undefined];

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
const encode = (msg: string) => Buffer.from(msg, 'utf8').toString('base64url');
const inMinutes = (m: number) => new Date(Date.now() + (m * 60_000)).toISOString().replace(/\.\d{3}Z$/, 'Z');

let tools: Map<string, Handler>;
const api = vi.mocked(makeGmailApiCall);
const calls = () => api.mock.calls as unknown as Call[];

beforeEach(() => {
	api.mockReset();
	tools = new Map();
	const server = {
		registerTool: vi.fn((name: string, _meta: unknown, handler: Handler) => {
			tools.set(name, handler);
		}),
	} as unknown as McpServer;
	registerAll(server, {token: 't'} as Config);
});

/** Route mocked Gmail calls by method + path. */
function routeApi(routes: Record<string, (body?: Record<string, unknown>) => unknown>) {
	api.mockImplementation(async (method: string, endpoint: string, _token: string, body?: unknown) => {
		const key = `${method} ${endpoint.split('?')[0]}`;
		const hit = Object.entries(routes).find(([pattern]) => new RegExp(`^${pattern}$`).test(key));
		if (!hit) {
			throw new Error(`unrouted ${key}`);
		}

		return hit[1](body as Record<string, unknown>);
	});
}

describe('parseSendAt', () => {
	const now = new Date('2026-10-12T12:00:00Z');

	it('accepts an offset time and returns the right instant', () => {
		expect(parseSendAt('2026-10-13T08:00:00-06:00', now).toISOString()).toBe('2026-10-13T14:00:00.000Z');
	});

	it('refuses a time with no zone', () => {
		expect(() => parseSendAt('2026-10-13T08:00:00', now)).toThrow(/time zone offset/);
	});

	it('refuses a time under 2 minutes away and over 365 days away', () => {
		expect(() => parseSendAt('2026-10-12T12:01:00Z', now)).toThrow(/less than 2 minutes/);
		expect(() => parseSendAt('2027-10-13T12:00:00Z', now)).toThrow(/365 days/);
	});

	it('refuses a newline smuggled into the value', () => {
		expect(() => parseSendAt('2026-10-13T08:00:00Z\r\nBcc: x@evil.test', now)).toThrow();
	});
});

describe('setScheduleMarker', () => {
	const msg = 'To: a@example.com\r\nX-Scheduled-Send: 2026-01-01T00:00:00.000Z\r\nSubject: hi\r\n\r\nX-Scheduled-Send: quoted in body';

	it('replaces the marker in the header block and leaves the body alone', () => {
		const out = setScheduleMarker(msg, new Date('2026-10-13T14:00:00Z'));
		const [head, body] = out.split('\r\n\r\n');
		expect(head!.match(/X-Scheduled-Send/g)).toHaveLength(1);
		expect(head).toContain('X-Scheduled-Send: 2026-10-13T14:00:00.000Z');
		expect(body).toBe('X-Scheduled-Send: quoted in body');
	});

	it('removes the marker, folded lines included, and nothing else', () => {
		const folded = 'To: a@example.com\r\nx-scheduled-send:\r\n 2026-01-01T00:00:00Z\r\nSubject: hi\r\n\r\nbody';
		expect(setScheduleMarker(folded, undefined)).toBe('To: a@example.com\r\nSubject: hi\r\n\r\nbody');
	});
});

describe('draft_schedule', () => {
	it('creates a draft carrying the UTC marker and applies the label', async () => {
		routeApi({
			'POST /users/me/drafts': () => ({id: 'd1', message: {id: 'm1', threadId: 't1'}}),
			'GET /users/me/labels': () => ({labels: [{id: 'Label_9', name: 'Scheduled-Send'}]}),
			'POST /users/me/messages/m1/modify': () => ({}),
		});
		const sendAt = inMinutes(60);
		const res = await tools.get('draft_schedule')!({to: 'a@example.com', subject: 'Hi', body: 'b', sendAt});

		const create = calls().find(([m, e]) => m === 'POST' && e === '/users/me/drafts')!;
		const raw = decode((create[3] as {message: {raw: string}}).message.raw);
		expect(raw.split('\r\n\r\n')[0]).toContain(`X-Scheduled-Send: ${new Date(sendAt).toISOString()}`);
		expect(calls().some(([m, e, , b]) => m === 'POST' && e === '/users/me/messages/m1/modify'
			&& JSON.stringify(b) === JSON.stringify({addLabelIds: ['Label_9']}))).toBe(true);
		expect(res.structuredContent).toMatchObject({draftId: 'd1', sendAt: new Date(sendAt).toISOString()});
		expect(res.structuredContent.labelWarning).toBeUndefined();
	});

	it('creates the label when missing', async () => {
		routeApi({
			'POST /users/me/drafts': () => ({id: 'd1', message: {id: 'm1', threadId: 't1'}}),
			'GET /users/me/labels': () => ({labels: []}),
			'POST /users/me/labels': () => ({id: 'Label_new'}),
			'POST /users/me/messages/m1/modify': () => ({}),
		});
		await tools.get('draft_schedule')!({to: 'a@example.com', subject: 'Hi', body: 'b', sendAt: inMinutes(60)});
		expect(calls().some(([m, e, , b]) => m === 'POST' && e === '/users/me/labels' && b?.name === 'Scheduled-Send')).toBe(true);
	});

	it('still schedules when labelling fails, and says so', async () => {
		routeApi({
			'POST /users/me/drafts': () => ({id: 'd1', message: {id: 'm1', threadId: 't1'}}),
			'GET /users/me/labels': () => {
				throw new Error('boom');
			},
		});
		const res = await tools.get('draft_schedule')!({to: 'a@example.com', subject: 'Hi', body: 'b', sendAt: inMinutes(60)});
		expect(res.structuredContent.draftId).toBe('d1');
		expect(res.structuredContent.labelWarning).toMatch(/boom/);
	});

	it('creates nothing when sendAt is invalid', async () => {
		routeApi({});
		await expect(tools.get('draft_schedule')!({to: 'a@example.com', subject: 'Hi', body: 'b', sendAt: inMinutes(1)})).rejects.toThrow(/2 minutes/);
		expect(calls()).toHaveLength(0);
	});
});

describe('scheduled_update and scheduled_cancel', () => {
	const original = 'To: a@example.com\r\nX-Scheduled-Send: 2026-01-01T00:00:00.000Z\r\nSubject: hi\r\n\r\nbody';

	function draftRoutes(extra: Record<string, (body?: Record<string, unknown>) => unknown> = {}) {
		return {
			'GET /users/me/drafts/d1': () => ({id: 'd1', message: {id: 'm1', threadId: 't1', raw: encode(original)}}),
			'PUT /users/me/drafts/d1': () => ({id: 'd1', message: {id: 'm2', threadId: 't1'}}),
			'GET /users/me/labels': () => ({labels: [{id: 'Label_9', name: 'Scheduled-Send'}]}),
			'POST /users/me/messages/m2/modify': () => ({}),
			...extra,
		};
	}

	const putRaw = () => {
		const put = calls().find(([m]) => m === 'PUT')!;
		return {
			raw: decode((put[3] as {message: {raw: string}}).message.raw),
			threadId: (put[3] as {message: {threadId: string}}).message.threadId,
		};
	};

	it('update swaps the time, keeps the thread, labels the new message', async () => {
		routeApi(draftRoutes());
		const sendAt = inMinutes(120);
		await tools.get('scheduled_update')!({draftId: 'd1', sendAt});
		const {raw, threadId} = putRaw();
		expect(raw).toContain(`X-Scheduled-Send: ${new Date(sendAt).toISOString()}`);
		expect(raw).not.toContain('2026-01-01');
		expect(threadId).toBe('t1');
		expect(calls().some(([m, e, , b]) => e === '/users/me/messages/m2/modify' && m === 'POST' && JSON.stringify(b) === JSON.stringify({addLabelIds: ['Label_9']}))).toBe(true);
	});

	it('cancel strips the marker and removes the label', async () => {
		routeApi(draftRoutes());
		const res = await tools.get('scheduled_cancel')!({draftId: 'd1'});
		expect(putRaw().raw).toBe('To: a@example.com\r\nSubject: hi\r\n\r\nbody');
		expect(calls().some(([, e, , b]) => e === '/users/me/messages/m2/modify' && JSON.stringify(b) === JSON.stringify({removeLabelIds: ['Label_9']}))).toBe(true);
		expect(res.structuredContent).toMatchObject({cancelled: true, deleted: false});
	});

	it('cancel with delete removes the draft and rewrites nothing', async () => {
		routeApi({'DELETE /users/me/drafts/d1': () => ({})});
		const res = await tools.get('scheduled_cancel')!({draftId: 'd1', delete: true});
		expect(calls().map(([m]) => m)).toEqual(['DELETE']);
		expect(res.structuredContent).toMatchObject({deleted: true});
	});
});

describe('scheduled_list', () => {
	it('returns only marked drafts, soonest first, flagging overdue ones', async () => {
		const late = new Date(Date.now() - (20 * 60_000)).toISOString();
		const soon = new Date(Date.now() + (5 * 60_000)).toISOString();
		const meta = (id: string, marker?: string) => ({
			id, threadId: `t${id}`, payload: {headers: [
				{name: 'To', value: 'a@example.com'}, {name: 'Subject', value: `s${id}`},
				...(marker ? [{name: 'X-Scheduled-Send', value: marker}] : []),
			]},
		});
		routeApi({
			'GET /users/me/drafts': () => ({drafts: [
				{id: 'd1', message: {id: 'm1', threadId: 't'}},
				{id: 'd2', message: {id: 'm2', threadId: 't'}},
				{id: 'd3', message: {id: 'm3', threadId: 't'}},
			]}),
			'GET /users/me/messages/m1': () => meta('m1', soon),
			'GET /users/me/messages/m2': () => meta('m2'),
			'GET /users/me/messages/m3': () => meta('m3', late),
		});
		const res = await tools.get('scheduled_list')!({maxDrafts: 200});
		const list = res.structuredContent.scheduled as {draftId: string; overdue: boolean}[];
		expect(list.map((s) => s.draftId)).toEqual(['d3', 'd1']);
		expect(list.map((s) => s.overdue)).toEqual([true, false]);
		expect(res.structuredContent.overdueCount).toBe(1);
	});

	it('reads the marker case-insensitively and ignores garbage', () => {
		expect(readScheduleMarker([{name: 'x-scheduled-send', value: '2026-10-13T14:00:00.000Z'}])?.toISOString()).toBe('2026-10-13T14:00:00.000Z');
		expect(readScheduleMarker([{name: 'X-Scheduled-Send', value: 'soon'}])).toBeUndefined();
	});
});
