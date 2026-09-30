import {checkToken} from './token-cache.js';

/**
 * HTTP answers for the two places this server talks to Google on a client's
 * behalf. Both separate "Google could not be reached" from "the credential is
 * bad", because mcp-remote (the client in front of every daemon) reacts to the
 * two very differently:
 *
 * - A 401 from /mcp starts its auth flow. A 503 is just a failed request that
 *   the next call retries.
 * - Inside that auth flow, a refresh that fails with a ServerError (which is
 *   what `server_error` and any non-OAuth body parse to) falls through to
 *   opening a browser for a fresh login. A refresh that fails with
 *   `temporarily_unavailable` is rethrown instead, so no browser opens.
 *
 * Before this split, a cold boot with no network turned into three Chrome login
 * windows and three relays hung waiting on them (2026-09-29).
 */

export type GateResult = {status: number; body: unknown};

export async function mcpAuthFailure(token: string): Promise<GateResult | undefined> {
	const status = await checkToken(token);
	if (status === 'valid') {
		return undefined;
	}

	if (status === 'unreachable') {
		return {
			status: 503,
			body: {jsonrpc: '2.0', error: {code: -32000, message: 'Google unreachable, try again shortly'}, id: null},
		};
	}

	return {
		status: 401,
		body: {jsonrpc: '2.0', error: {code: -32001, message: 'Unauthorized: Invalid or expired token'}, id: null},
	};
}

export async function proxyTokenRequest(endpoint: string, form: URLSearchParams): Promise<GateResult> {
	let response: globalThis.Response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers: {'Content-Type': 'application/x-www-form-urlencoded'},
			body: form.toString(),
		});
	} catch (error) {
		console.error('Token exchange error:', error);
		return temporarilyUnavailable();
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch (error) {
		console.error('Token exchange error: non-JSON reply from Google, HTTP', response.status, error);
		return temporarilyUnavailable();
	}

	// A Google 5xx says nothing about the refresh token, so it must not reach the
	// client as a server_error (which would open a browser). Its 4xx answers,
	// such as invalid_grant for a revoked token, pass through untouched so a
	// genuinely dead login still triggers a fresh sign-in.
	if (response.status >= 500) {
		console.error('Token exchange error: Google returned HTTP', response.status);
		return temporarilyUnavailable();
	}

	return {status: response.status, body: data};
}

function temporarilyUnavailable(): GateResult {
	return {
		status: 503,
		body: {error: 'temporarily_unavailable', error_description: 'Could not reach Google, try again shortly'},
	};
}
