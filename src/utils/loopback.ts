/**
 * Host / Origin / redirect_uri gate.
 *
 * The server binds 127.0.0.1, but binding alone does not stop a DNS rebinding
 * attack: a hostile page can resolve its own domain to 127.0.0.1, at which
 * point the browser treats requests to this server as same-origin and CORS
 * offers no protection. The defence is to reject any request whose Host or
 * Origin is not a loopback name (MCP spec, "Security Warning" on the
 * Streamable HTTP transport).
 *
 * Two SEPARATE escape hatches, deliberately not one:
 *   GMAIL_MCP_EXTRA_HOSTS          - extra names this server will answer for
 *   GMAIL_MCP_EXTRA_REDIRECT_HOSTS - extra OAuth redirect_uri targets
 * A single variable feeding both meant that widening the first to make a
 * client reachable silently widened the second, turning an attacker-supplied
 * host into a valid place to deliver an authorization code.
 *
 * Lives in its own module, separate from the express wiring in main.ts, so the
 * rules are testable without standing up a server.
 */

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

export type GateResult =
	| {ok: true}
	| {ok: false; status: number; error: string; description: string};

export type LoopbackGate = {
	isAllowedHostHeader(hostHeader?: string): boolean;
	isAllowedRedirect(value: string): boolean;
	check(headers: {host?: string; origin?: string}): GateResult;
};

function hostsFromEnv(env: Record<string, string | undefined>, name: string): string[] {
	return (env[name] ?? '')
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
}

export function createLoopbackGate(env: Record<string, string | undefined> = process.env): LoopbackGate {
	const hostAllowlist = new Set([...LOOPBACK_HOSTS, ...hostsFromEnv(env, 'GMAIL_MCP_EXTRA_HOSTS')]);
	const redirectAllowlist = new Set([...LOOPBACK_HOSTS, ...hostsFromEnv(env, 'GMAIL_MCP_EXTRA_REDIRECT_HOSTS')]);

	function isAllowedHostHeader(hostHeader?: string): boolean {
		if (!hostHeader) {
			return false;
		}

		// Strip the port. Bracketed IPv6 literals keep their brackets.
		const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
		return hostAllowlist.has(host);
	}

	function isLoopbackUrl(value: string, allowlist: Set<string>): boolean {
		try {
			const url = new URL(value);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				return false;
			}

			return allowlist.has(url.hostname.toLowerCase());
		} catch {
			return false;
		}
	}

	return {
		isAllowedHostHeader,

		isAllowedRedirect: (value: string) => isLoopbackUrl(value, redirectAllowlist),

		check({host, origin}) {
			if (!isAllowedHostHeader(host)) {
				return {
					ok: false,
					status: 403,
					error: 'forbidden_host',
					description: 'This server only accepts requests addressed to a loopback host.',
				};
			}

			// `null` is NOT exempt. Programmatic MCP clients send no Origin at
			// all, which is already allowed; a literal `null` origin comes from
			// a browsing context (sandboxed iframe, data: URL) and has no
			// legitimate reason to reach this server.
			if (origin && !isLoopbackUrl(origin, hostAllowlist)) {
				return {
					ok: false,
					status: 403,
					error: 'forbidden_origin',
					description: 'Cross-origin requests are not accepted.',
				};
			}

			return {ok: true};
		},
	};
}
