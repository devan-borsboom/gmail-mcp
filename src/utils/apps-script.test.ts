import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {describe, it, expect, beforeEach} from 'vitest';

// Runs apps-script/scheduled-send.gs against an in-memory fake of the Apps
// Script runtime, so the send logic is exercised before it is pasted into a
// Google account.
const SCRIPT = readFileSync(fileURLToPath(new URL('../../apps-script/scheduled-send.gs', import.meta.url)), 'utf8');

type Draft = {id: string; messageId: string; threadId: string; raw: string; labels: string[]};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function makeRuntime(opts: {rawAsBytes?: boolean; failSend?: boolean} = {}) {
	const drafts = new Map<string, Draft>();
	const sent: {raw: string; threadId: string}[] = [];
	const alerts: {to: string; subject: string}[] = [];
	const props = new Map<string, string>();
	const labels = [{id: 'L1', name: 'Scheduled-Send'}];
	let nextMsg = 100;

	const headerOf = (raw: string, name: string) => {
		const head = raw.split(/\r?\n\r?\n/)[0]!;
		const line = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
		return line ? {name, value: line.slice(name.length + 1).trim()} : undefined;
	};

	const byMessage = (id: string) => [...drafts.values()].find((d) => d.messageId === id)!;

	const Gmail = {Users: {
		Drafts: {
			list(_u: string, args: {q?: string}) {
				const all = [...drafts.values()].filter((d) => !args.q || d.labels.includes('L1'));
				return {drafts: all.map((d) => ({id: d.id, message: {id: d.messageId, threadId: d.threadId}}))};
			},
			get(_u: string, id: string) {
				const d = drafts.get(id)!;
				return {id, message: {id: d.messageId, threadId: d.threadId, raw: opts.rawAsBytes ? [...Buffer.from(d.raw, 'utf8')] : b64(d.raw)}};
			},
			update(res: {message: {raw: string; threadId: string}}, _u: string, id: string) {
				const d = drafts.get(id)!;
				d.raw = unb64(res.message.raw);
				d.messageId = `m${nextMsg++}`;
				d.labels = []; // Gmail gives the replacement message a fresh id
				return {id, message: {id: d.messageId, threadId: d.threadId}};
			},
			send(res: {id: string}) {
				if (opts.failSend) {
					throw new Error('quota');
				}

				const d = drafts.get(res.id)!;
				drafts.delete(res.id);
				sent.push({raw: d.raw, threadId: d.threadId});
				return {id: `s${nextMsg++}`, threadId: d.threadId};
			},
		},
		Messages: {
			get(_u: string, id: string, args: {metadataHeaders: string[]}) {
				const d = byMessage(id);
				return {id, payload: {headers: args.metadataHeaders.map((h) => headerOf(d.raw, h)).filter(Boolean)}};
			},
			modify(res: {addLabelIds?: string[]}, _u: string, id: string) {
				const d = [...drafts.values()].find((x) => x.messageId === id);
				if (d && res.addLabelIds) {
					d.labels.push(...res.addLabelIds);
				}

				return {};
			},
		},
		Labels: {
			list: () => ({labels}),
			create(res: {name: string}) {
				const l = {id: `L${labels.length + 1}`, name: res.name};
				labels.push(l);
				return l;
			},
		},
	}};

	const sandbox = {
		Gmail,
		Utilities: {
			Charset: {UTF_8: 'UTF-8'},
			base64EncodeWebSafe: (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
			base64DecodeWebSafe: (s: string) => [...Buffer.from(s, 'base64url')],
			newBlob: (bytes: number[]) => ({getDataAsString: () => Buffer.from(bytes).toString('utf8')}),
		},
		PropertiesService: {getScriptProperties: () => ({
			getProperty: (k: string) => props.get(k) ?? null,
			setProperty: (k: string, v: string) => props.set(k, v),
			deleteProperty: (k: string) => props.delete(k),
			getProperties: () => Object.fromEntries(props),
		})},
		LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})},
		MailApp: {sendEmail: (to: string, subject: string) => alerts.push({to, subject})},
		Session: {getEffectiveUser: () => ({getEmail: () => 'me@example.com'})},
		ScriptApp: {getProjectTriggers: () => [], newTrigger: () => ({timeBased: () => ({everyMinutes: () => ({create() {}})})})},
		Logger: {log() {}},
	};
	vm.createContext(sandbox);
	vm.runInContext(SCRIPT, sandbox);
	const run = () => vm.runInContext('sendDue()', sandbox) as void;

	const add = (id: string, raw: string, labelled = true) => {
		drafts.set(id, {id, messageId: `m${nextMsg++}`, threadId: `t-${id}`, raw, labels: labelled ? ['L1'] : []});
	};

	return {drafts, sent, alerts, props, run, add};
}

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString();
const msg = (marker?: string, subject = 'Hi') => `${marker ? `X-Scheduled-Send: ${marker}\r\n` : ''}To: a@example.com\r\nSubject: ${subject}\r\n\r\nX-Scheduled-Send: body text stays`;

describe('scheduled-send.gs', () => {
	let rt: ReturnType<typeof makeRuntime>;
	beforeEach(() => {
		rt = makeRuntime();
	});

	it('sends a due draft with the marker stripped from the headers only, on its thread', () => {
		rt.add('d1', msg(past));
		rt.run();
		expect(rt.sent).toHaveLength(1);
		expect(rt.sent[0]!.raw).toBe('To: a@example.com\r\nSubject: Hi\r\n\r\nX-Scheduled-Send: body text stays');
		expect(rt.sent[0]!.threadId).toBe('t-d1');
		expect(rt.alerts).toHaveLength(0);
	});

	it('leaves a future draft and a plain draft alone', () => {
		rt.add('d1', msg(future));
		rt.add('d2', msg(undefined), false);
		rt.run();
		expect(rt.sent).toHaveLength(0);
		expect(rt.drafts.size).toBe(2);
	});

	it('sends a due draft whose label never applied, via the full scan', () => {
		rt.add('d1', msg(past), false);
		rt.run();
		expect(rt.sent).toHaveLength(1);
	});

	it('sends once, never twice, across repeated runs', () => {
		rt.add('d1', msg(past));
		rt.run();
		rt.run();
		expect(rt.sent).toHaveLength(1);
	});

	it('handles raw arriving as bytes', () => {
		rt = makeRuntime({rawAsBytes: true});
		rt.add('d1', msg(past, 'Café ✓'));
		rt.run();
		expect(rt.sent[0]!.raw).toContain('Subject: Café ✓');
		expect(rt.sent[0]!.raw).not.toMatch(/^X-Scheduled-Send/);
	});

	it('on a failed send: restores the marker, labels it Failed, alerts once, does not retry', () => {
		rt = makeRuntime({failSend: true});
		rt.add('d1', msg(past));
		rt.run();
		rt.run();
		const d = rt.drafts.get('d1')!;
		expect(d.raw.startsWith(`X-Scheduled-Send: ${past}`)).toBe(true);
		expect(d.labels).toContain('L2'); // Scheduled-Send/Failed, created on demand
		expect(rt.alerts).toHaveLength(1);
		expect(rt.alerts[0]!.subject).toMatch(/FAILED/);
		expect(rt.sent).toHaveLength(0);
	});

	it('alerts once when a labelled draft has lost its send time', () => {
		rt.add('d1', msg(undefined, 'Edited'));
		rt.run();
		rt.run();
		expect(rt.alerts).toHaveLength(1);
		expect(rt.alerts[0]!.subject).toMatch(/lost its send time/);
		expect(rt.sent).toHaveLength(0);
	});

	it('reports a send interrupted part-way', () => {
		rt.props.set('inflight:d9', JSON.stringify({at: Date.now() - (20 * 60_000), subject: 'Stuck'}));
		rt.run();
		expect(rt.alerts.map((a) => a.subject)).toEqual(['Scheduled email may not have sent: Stuck']);
		expect(rt.props.has('inflight:d9')).toBe(false);
	});
});
