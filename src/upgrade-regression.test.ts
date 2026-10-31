/**
 * Regression guard for the zod 3 -> 4 and MCP SDK 1.30 -> 1.32 upgrade
 * (2026-10-31, npm audit cleanup).
 *
 * The other test files call registerAll() against a stub server, so they never
 * exercise the real SDK: how it turns a zod schema into the JSON schema a
 * client sees, or how it validates arguments before a handler runs. Those are
 * exactly the two things a zod major bump can silently break. This file drives
 * the real McpServer through a real Client, and the built HTTP server through
 * real sockets.
 *
 * The expected tool surface comes from a capture of the live, pre-upgrade
 * build (src/__fixtures__/tools-list-eeea9eb.json), not from this code.
 */
import {
	describe, it, expect, vi, beforeAll, afterAll,
} from 'vitest';
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {createServer as createNetServer} from 'node:net';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeGmailApiCall} from './utils/gmail-api.js';
import {createServer} from './index.js';

vi.mock('./utils/gmail-api.js', () => ({
	makeGmailApiCall: vi.fn(),
	GMAIL_API_BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
}));

const here = __dirname;

type FixtureTool = {
	properties: string[];
	required: string[];
	additionalProperties: unknown;
	readOnlyHint: unknown;
};
const fixture = JSON.parse(readFileSync(join(here, '__fixtures__', 'tools-list-eeea9eb.json'), 'utf8')) as {tools: Record<string, FixtureTool>};

async function connectedClient(): Promise<Client> {
	const server = createServer({token: 'test-token'});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({name: 'upgrade-regression', version: '0.0.0'});
	await client.connect(clientSide);
	return client;
}

describe('tool surface through the real SDK matches the pre-upgrade build', () => {
	// A const holder, so the per-tool tests below do not close over a
	// reassigned variable.
	const listed: {tools: Awaited<ReturnType<Client['listTools']>>['tools']} = {tools: []};

	beforeAll(async () => {
		const client = await connectedClient();
		listed.tools = (await client.listTools()).tools;
	});

	it('lists exactly the same tool names', () => {
		expect(listed.tools.map((t) => t.name).sort()).toEqual(Object.keys(fixture.tools).sort());
	});

	for (const [name, expected] of Object.entries(fixture.tools)) {
		it(`${name}: same parameters, required set, strictness and read-only hint`, () => {
			const tool = listed.tools.find((t) => t.name === name);
			expect(tool, name).toBeDefined();
			const schema = tool!.inputSchema as {properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown};
			expect(Object.keys(schema.properties ?? {}).sort(), `${name} properties`).toEqual(expected.properties);
			expect([...(schema.required ?? [])].sort(), `${name} required`).toEqual(expected.required);
			expect(schema.additionalProperties, `${name} additionalProperties`).toEqual(expected.additionalProperties);
			// The fixture records a missing hint as null.
			expect(tool!.annotations?.readOnlyHint ?? null, `${name} readOnlyHint`).toEqual(expected.readOnlyHint);
		});
	}
});

describe('argument validation still runs inside the real SDK, before any Gmail call', () => {
	const injected = 'Quick question\r\nBcc: attacker@example.com';

	for (const field of ['to', 'subject', 'cc', 'bcc', 'from'] as const) {
		it(`message_send refuses a newline in ${field} and never reaches Gmail`, async () => {
			vi.mocked(makeGmailApiCall).mockClear();
			const client = await connectedClient();
			const args: Record<string, unknown> = {to: 'corey@example.com', subject: 'Re: port', body: 'hi'};
			args[field] = injected;
			const result = await client.callTool({name: 'message_send', arguments: args});
			expect(result.isError, field).toBe(true);
			expect(JSON.stringify(result.content), field).toMatch(/newline/i);
			expect(makeGmailApiCall).not.toHaveBeenCalled();
		});
	}

	it('message_send refuses an unknown parameter (strict schema survived)', async () => {
		vi.mocked(makeGmailApiCall).mockClear();
		const client = await connectedClient();
		const result = await client.callTool({
			name: 'message_send',
			arguments: {
				to: 'a@example.com', subject: 's', body: 'b', smuggled: 'x',
			},
		});
		expect(result.isError).toBe(true);
		expect(makeGmailApiCall).not.toHaveBeenCalled();
	});

	it('message_send refuses an attachment path outside the allowlist and never reaches Gmail', async () => {
		vi.mocked(makeGmailApiCall).mockClear();
		const client = await connectedClient();
		const result = await client.callTool({
			name: 'message_send',
			arguments: {
				to: 'a@example.com', subject: 's', body: 'b', attachments: [{path: '/etc/hosts'}],
			},
		});
		expect(result.isError).toBe(true);
		expect(makeGmailApiCall).not.toHaveBeenCalled();
	});

	it('get_profile still returns structured output that passes the output schema', async () => {
		vi.mocked(makeGmailApiCall).mockResolvedValueOnce({emailAddress: 'someone@example.com', messagesTotal: 1});
		const client = await connectedClient();
		const result = await client.callTool({name: 'get_profile', arguments: {}});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({emailAddress: 'someone@example.com'});
	});
});

// ---------------------------------------------------------------------------
// HTTP server: the built dist/main.js on a spare port with dummy credentials.
// ---------------------------------------------------------------------------

const distMain = join(here, '..', 'dist', 'main.js');

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

describe('built HTTP server keeps its network protections', () => {
	let child: ChildProcess;
	let port: number;
	let base: string;

	beforeAll(async () => {
		if (!existsSync(distMain)) {
			throw new Error('dist/main.js missing: run `npm run build` before the tests');
		}

		port = await freePort();
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

	const post = async (headers: Record<string, string>, body: unknown) => fetch(`${base}/mcp`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers},
		body: JSON.stringify(body),
	});
	const toolsList = {
		jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
	};

	// Node's fetch will not let us override Host, so use a raw HTTP request.
	async function rawGet(path: string, host: string, extra: Record<string, string> = {}): Promise<number> {
		const http = await import('node:http');
		return new Promise((resolve, reject) => {
			const req = http.request({
				host: '127.0.0.1', port, path, method: 'GET', headers: {Host: host, ...extra},
			}, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on('error', reject);
			req.end();
		});
	}

	it('Host gate: a rebinding Host is refused with 403', async () => {
		expect(await rawGet('/.well-known/oauth-authorization-server', 'evil.example.com')).toBe(403);
		expect(await rawGet('/.well-known/oauth-authorization-server', `evil.example.com:${port}`)).toBe(403);
	});

	it('Host gate: the loopback Host is let through', async () => {
		expect(await rawGet('/.well-known/oauth-authorization-server', `127.0.0.1:${port}`)).toBe(200);
	});

	it('Origin gate: a literal null Origin is refused', async () => {
		expect(await rawGet('/.well-known/oauth-authorization-server', `127.0.0.1:${port}`, {Origin: 'null'})).toBe(403);
	});

	it('Origin gate: a cross-origin request is refused', async () => {
		const res = await post({Origin: 'https://evil.example.com'}, toolsList);
		expect(res.status).toBe(403);
	});

	it('OAuth: /authorize refuses a non-loopback redirect_uri', async () => {
		const res = await fetch(`${base}/authorize?redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`, {redirect: 'manual'});
		expect(res.status).toBe(400);
	});

	it('OAuth: /authorize accepts a loopback redirect_uri and sends the user to Google', async () => {
		const res = await fetch(`${base}/authorize?redirect_uri=${encodeURIComponent('http://127.0.0.1:9999/cb')}`, {redirect: 'manual'});
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
	});

	it('OAuth: /callback re-checks the redirect carried in state', async () => {
		const state = Buffer.from(JSON.stringify({redirect_uri: 'https://evil.example.com/cb', state: 's'})).toString('base64url');
		const res = await fetch(`${base}/callback?code=abc&state=${state}`, {redirect: 'manual'});
		expect(res.status).toBe(400);
	});

	it('MCP: tools/list is reachable without a token, tools/call is not', async () => {
		const list = await post({}, toolsList);
		expect(list.status).toBe(200);
		const listed = await list.json() as {result: {tools: unknown[]}};
		expect(listed.result.tools.length).toBe(Object.keys(fixture.tools).length);

		const call = await post({}, {
			jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'get_profile', arguments: {}},
		});
		expect(call.status).toBe(401);
	});

	it('binds to loopback only: a non-loopback interface address is not listening', async () => {
		const external = Object.values(networkInterfaces()).flat()
			.find((i) => i?.family === 'IPv4' && !i.internal)?.address;
		if (!external) {
			// No non-loopback interface on this machine; nothing to probe.
			return;
		}

		await expect(fetch(`http://${external}:${port}/.well-known/oauth-authorization-server`, {signal: AbortSignal.timeout(3000)})).rejects.toThrow();
	});
});
