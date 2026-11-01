/**
 * An oversized or malformed request body must come back as JSON the client can
 * read, never express's default HTML error page. mcp-remote (the client in
 * front of every daemon) does not answer the JSON-RPC request after a non-2xx
 * reply it cannot parse, so a message_send with large inline base64
 * attachments used to hang the tool call instead of failing with a reason.
 *
 * Drives the built dist/main.js through real sockets, like
 * upgrade-regression.test.ts. GMAIL_MCP_DIST points it at another build.
 */
import {
	describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createServer as createNetServer} from 'node:net';
import {join} from 'node:path';
import {idFromHead, idFromTail} from './utils/body-limit.js';

const distMain = process.env.GMAIL_MCP_DIST ?? join(__dirname, '..', 'dist', 'main.js');

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createNetServer();
		s.once('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const addr = s.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			s.close(() => {
				resolve(port);
			});
		});
	});
}

describe('built HTTP server answers body errors in JSON', () => {
	let child: ChildProcess;
	let base: string;

	beforeAll(async () => {
		if (!existsSync(distMain)) {
			throw new Error(`${distMain} missing: run \`npm run build\` before the tests`);
		}

		const port = await freePort();
		base = `http://127.0.0.1:${port}`;
		child = spawn(process.execPath, [distMain], {
			env: {
				PATH: process.env.PATH ?? '',
				MCP_TRANSPORT: 'http',
				PORT: String(port),
				GOOGLE_CLIENT_ID: 'dummy-client-id',
				GOOGLE_CLIENT_SECRET: 'dummy-client-secret',
			},
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error('server did not start within 10s'));
			}, 10_000);
			child.stderr!.on('data', (chunk: Buffer) => {
				if (chunk.toString().includes('running on')) {
					clearTimeout(timer);
					resolve();
				}
			});
			child.once('exit', (code) => {
				clearTimeout(timer);
				reject(new Error(`server exited early with code ${code}`));
			});
		});
	}, 15_000);

	afterAll(() => {
		child?.kill('SIGTERM');
	});

	// Shaped like the SDK's own requests: `id` is the last key.
	const bigSend = (id: number | string) => JSON.stringify({
		method: 'tools/call',
		params: {
			name: 'message_send',
			arguments: {
				to: 'nobody@example.com',
				subject: 'big',
				body: 'x',
				attachments: [{filename: 'big.bin', mimeType: 'application/octet-stream', content: 'A'.repeat(21 * 1024 * 1024)}],
			},
		},
		jsonrpc: '2.0',
		id,
	});

	const postRaw = async (body: string, headers: Record<string, string> = {}) => fetch(`${base}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer dummy', ...headers,
		},
		body,
	});

	it('a body over the 20 MB limit gets a JSON-RPC error carrying the request id', async () => {
		const res = await postRaw(bigSend(7));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
		const reply = await res.json() as {jsonrpc: string; id: unknown; error: {code: number; message: string}};
		expect(reply.jsonrpc).toBe('2.0');
		expect(reply.id).toBe(7);
		expect(reply.error.message).toMatch(/20 MB/);
		expect(reply.error.message).toMatch(/path/);
	}, 30_000);

	it('a string request id is carried back too', async () => {
		const res = await postRaw(bigSend('req-"x"-9'));
		const reply = await res.json() as {id: unknown};
		expect(reply.id).toBe('req-"x"-9');
	}, 30_000);

	it('an oversized body whose id comes before the big params still gets its id back', async () => {
		const res = await postRaw(JSON.stringify({
			jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 'message_send', arguments: {body: 'A'.repeat(21 * 1024 * 1024)}},
		}));
		expect(res.status).toBe(200);
		const reply = await res.json() as {id: unknown; error: {message: string}};
		expect(reply.id).toBe(8);
		expect(reply.error.message).toMatch(/20 MB/);
	}, 30_000);

	it('an unparseable /mcp body gets a JSON-RPC parse error, not an HTML page', async () => {
		const res = await postRaw('{not json');
		expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
		const reply = await res.json() as {jsonrpc: string; error: {code: number}};
		expect(reply.jsonrpc).toBe('2.0');
		expect(reply.error.code).toBe(-32700);
	});

	it('a form body with too many fields on /token gets a JSON error, not an HTML page', async () => {
		const form = Array.from({length: 1500}, (_, i) => `k${i}=v`).join('&');
		const res = await fetch(`${base}/token`, {
			method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: form,
		});
		expect(res.status).toBe(413);
		expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
		const reply = await res.json() as {error: string};
		expect(reply.error).toBe('invalid_request');
	});

	it('a normal-sized request still reaches the MCP handler', async () => {
		const res = await fetch(`${base}/mcp`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
			body: JSON.stringify({
				jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
			}),
		});
		expect(res.status).toBe(200);
		const listed = await res.json() as {result: {tools: unknown[]}};
		expect(listed.result.tools.length).toBeGreaterThan(10);
	});
});

describe('idFromTail', () => {
	it('reads a number or string id that ends the body', () => {
		expect(idFromTail('..."jsonrpc":"2.0","id":12}')).toBe(12);
		expect(idFromTail('..."id" : "a\\"b" }\n')).toBe('a"b');
	});

	it('gives null when the id is not the last key or the tail is cut', () => {
		expect(idFromTail('{"id":3,"method":"x"}')).toBeNull();
		expect(idFromTail('AAAA')).toBeNull();
		expect(idFromTail('"id":{"x":1}}')).toBeNull();
	});
});

describe('idFromHead', () => {
	it('reads a top-level id written before the other keys', () => {
		expect(idFromHead('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"a":"AAAA')).toBe(8);
		expect(idFromHead(' { "id" : "a\\"b" , "params":')).toBe('a"b');
		expect(idFromHead('{"method":"x","params":{"id":5,"s":"}{"},"id":-3,"x"')).toBe(-3);
	});

	it('gives null when the id is not fully inside the head', () => {
		expect(idFromHead('{"jsonrpc":"2.0","id":12')).toBeNull();
		expect(idFromHead('{"jsonrpc":"2.0","id":"abc')).toBeNull();
		expect(idFromHead('{"params":{"id":5,"a":"AAAA')).toBeNull();
		expect(idFromHead('{"method":"tools/call","params":{"a":"AAAA')).toBeNull();
		expect(idFromHead('[{"id":1}]')).toBeNull();
		expect(idFromHead('{"id":{"x":1},')).toBeNull();
	});
});
