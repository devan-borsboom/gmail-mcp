import {
	describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {refreshAuthorization} from '@modelcontextprotocol/sdk/client/auth.js';
import {InvalidGrantError, ServerError, TemporarilyUnavailableError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {mcpAuthFailure, proxyTokenRequest} from './auth-gate.js';
import {clearTokenCache} from './token-cache.js';

/**
 * On 2026-09-29 the Mac booted before Wi-Fi was up. Every Google call threw,
 * the server answered "bad token" (401) and then "server_error" (500), and
 * mcp-remote responded by opening three Chrome login windows and hanging. These
 * tests pin the split between "Google unreachable" and "credential bad", and
 * check the /token answers against the real SDK client code mcp-remote runs.
 */

const networkDown = async () => Promise.reject(new TypeError('fetch failed', {cause: new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com')}));
const reply = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

beforeEach(() => {
	clearTokenCache();
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('/mcp token gate', () => {
	it('answers 503, not 401, when Google cannot be reached', async () => {
		vi.stubGlobal('fetch', vi.fn(networkDown));
		const failure = await mcpAuthFailure('tok-a');
		expect(failure?.status).toBe(503);
	});

	it('answers 503 when tokeninfo itself returns a 5xx', async () => {
		vi.stubGlobal('fetch', vi.fn(reply(502, 'Bad Gateway')));
		expect((await mcpAuthFailure('tok-b'))?.status).toBe(503);
	});

	it('still answers 401 for a token Google rejects', async () => {
		vi.stubGlobal('fetch', vi.fn(reply(400, {error: 'invalid_token'})));
		expect((await mcpAuthFailure('tok-c'))?.status).toBe(401);
	});

	it('lets a valid token through', async () => {
		vi.stubGlobal('fetch', vi.fn(reply(200, {expires_in: 3600})));
		expect(await mcpAuthFailure('tok-d')).toBeUndefined();
	});

	it('does not remember an outage: the same token passes once Google is back', async () => {
		vi.stubGlobal('fetch', vi.fn(networkDown));
		expect((await mcpAuthFailure('tok-e'))?.status).toBe(503);
		vi.stubGlobal('fetch', vi.fn(reply(200, {expires_in: 3600})));
		expect(await mcpAuthFailure('tok-e')).toBeUndefined();
	});
});

describe('/token proxy, as read by the real SDK refresh code', () => {
	const form = new URLSearchParams({grant_type: 'refresh_token', refresh_token: 'r'});

	// Feed our proxy's answer into the SDK's refreshAuthorization, which is the
	// exact call mcp-remote makes, and return what it throws.
	async function clientSees(googleFetch: () => Promise<Response>): Promise<unknown> {
		vi.stubGlobal('fetch', vi.fn(googleFetch));
		const result = await proxyTokenRequest('https://oauth2.googleapis.com/token', form);
		vi.unstubAllGlobals();
		const fetchFn = async () => new Response(JSON.stringify(result.body), {status: result.status, headers: {'Content-Type': 'application/json'}});
		try {
			await refreshAuthorization('http://localhost:3000', {
				clientInformation: {client_id: 'gmail-mcp'},
				refreshToken: 'r',
				fetchFn,
			});
			return undefined;
		} catch (error) {
			return error;
		}
	}

	// mcp-remote opens a browser for a ServerError and rethrows anything else.
	it('network down: the client gets temporarily_unavailable, not a ServerError', async () => {
		const error = await clientSees(networkDown);
		expect(error).toBeInstanceOf(TemporarilyUnavailableError);
		expect(error).not.toBeInstanceOf(ServerError);
	});

	it('Google 5xx with a non-JSON body: temporarily_unavailable', async () => {
		const error = await clientSees(reply(503, '<html>Service Unavailable</html>'));
		expect(error).toBeInstanceOf(TemporarilyUnavailableError);
	});

	it('Google 5xx with a JSON body: temporarily_unavailable', async () => {
		const error = await clientSees(reply(500, {error: 'internal_failure'}));
		expect(error).toBeInstanceOf(TemporarilyUnavailableError);
	});

	it('revoked refresh token still reaches the client as invalid_grant, so a real sign-out still re-logs in', async () => {
		const error = await clientSees(reply(400, {error: 'invalid_grant', error_description: 'Token has been expired or revoked.'}));
		expect(error).toBeInstanceOf(InvalidGrantError);
	});

	it('a good refresh passes the new tokens straight through', async () => {
		const error = await clientSees(reply(200, {access_token: 'new', token_type: 'Bearer', expires_in: 3599}));
		expect(error).toBeUndefined();
	});
});
