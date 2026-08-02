import {describe, it, expect} from 'vitest';
import {createLoopbackGate} from './loopback.js';

/**
 * The Host/Origin gate is the only thing standing between this server and a
 * DNS-rebinding attack: binding 127.0.0.1 does not stop a hostile page pointing
 * its own hostname at loopback. It shipped with no coverage at all and was
 * checked only by hand-run curl, so a refactor could have silently reverted it.
 */
describe('loopback gate', () => {
	const gate = createLoopbackGate({});

	describe('Host header', () => {
		it('accepts the loopback names, with and without a port', () => {
			for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3002', '[::1]', '[::1]:3001']) {
				expect(gate.isAllowedHostHeader(host), host).toBe(true);
			}
		});

		it('accepts a loopback name in any casing', () => {
			expect(gate.isAllowedHostHeader('LOCALHOST:3000')).toBe(true);
		});

		it('refuses a rebinding host, however it is dressed up', () => {
			for (const host of [
				'evil.com',
				'127.0.0.1.evil.com',
				'localhost.evil.com',
				'0.0.0.0',
				'2130706433',
				'127.1',
				'localhost.',
			]) {
				expect(gate.isAllowedHostHeader(host), host).toBe(false);
			}
		});

		it('refuses a request with no Host at all', () => {
			expect(gate.isAllowedHostHeader(undefined)).toBe(false);
			expect(gate.isAllowedHostHeader('')).toBe(false);
		});
	});

	describe('Origin header', () => {
		it('allows a request with no Origin, which is what programmatic clients send', () => {
			expect(gate.check({host: '127.0.0.1:3000'})).toEqual({ok: true});
		});

		it('refuses a literal null Origin, which only a browsing context sends', () => {
			const result = gate.check({host: '127.0.0.1:3000', origin: 'null'});
			expect(result).toMatchObject({ok: false, error: 'forbidden_origin'});
		});

		it('allows a loopback Origin on either scheme', () => {
			expect(gate.check({host: '127.0.0.1:3000', origin: 'http://localhost:6274'})).toEqual({ok: true});
			expect(gate.check({host: '127.0.0.1:3000', origin: 'https://127.0.0.1'})).toEqual({ok: true});
		});

		it('refuses a cross-origin request', () => {
			for (const origin of ['http://evil.com', 'http://127.0.0.1.evil.com', 'file://']) {
				expect(gate.check({host: '127.0.0.1:3000', origin}), origin).toMatchObject({
					ok: false,
					error: 'forbidden_origin',
				});
			}
		});

		it('checks the Host first, so a bad Host fails as forbidden_host', () => {
			expect(gate.check({host: 'evil.com', origin: 'http://localhost:3000'})).toMatchObject({
				ok: false,
				error: 'forbidden_host',
			});
		});
	});

	describe('OAuth redirect_uri', () => {
		it('accepts loopback targets, including the forms the URL parser normalises', () => {
			for (const uri of [
				'http://localhost:9999/cb',
				'http://127.0.0.1:9999/cb',
				'http://127.1/cb',
				'http://LOCALHOST/cb',
				'https://127.0.0.1/cb',
			]) {
				expect(gate.isAllowedRedirect(uri), uri).toBe(true);
			}
		});

		it('refuses every attacker-controlled target', () => {
			// eslint-disable-next-line no-script-url -- the hostile scheme is the thing under test
			const scriptUrl = 'javascript:alert(1)';
			for (const uri of [
				'http://localhost@evil.com/cb',
				'http://127.0.0.1.evil.com/cb',
				'http://[::1]@evil.com/cb',
				'http://localhost./cb',
				'http://0.0.0.0/cb',
				'https://evil.com/cb',
				scriptUrl,
				'//evil.com/cb',
				'',
			]) {
				expect(gate.isAllowedRedirect(uri), uri).toBe(false);
			}
		});
	});

	/**
	 * The two escape hatches were one variable until 9ee4bff. Widening the Host
	 * gate to make a client reachable also widened the set of places an
	 * authorization code could be delivered. These two tests are the regression
	 * guard for that split.
	 */
	describe('the two escape hatches stay separate', () => {
		it('GMAIL_MCP_EXTRA_HOSTS widens the Host gate but not the redirect gate', () => {
			const widened = createLoopbackGate({GMAIL_MCP_EXTRA_HOSTS: 'dev.internal'});
			expect(widened.isAllowedHostHeader('dev.internal:3000')).toBe(true);
			expect(widened.isAllowedRedirect('http://dev.internal/cb')).toBe(false);
		});

		it('GMAIL_MCP_EXTRA_REDIRECT_HOSTS widens the redirect gate but not the Host gate', () => {
			const widened = createLoopbackGate({GMAIL_MCP_EXTRA_REDIRECT_HOSTS: 'dev.internal'});
			expect(widened.isAllowedRedirect('http://dev.internal/cb')).toBe(true);
			expect(widened.isAllowedHostHeader('dev.internal:3000')).toBe(false);
		});

		it('accepts a comma-separated list and ignores whitespace and casing', () => {
			const widened = createLoopbackGate({GMAIL_MCP_EXTRA_HOSTS: ' A.internal , b.internal '});
			expect(widened.isAllowedHostHeader('a.internal')).toBe(true);
			expect(widened.isAllowedHostHeader('B.internal')).toBe(true);
		});
	});
});
