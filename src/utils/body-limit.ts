import type {NextFunction, Request, Response} from 'express';

/**
 * Request-body errors answered in JSON. express's default error page is HTML,
 * and mcp-remote (the client in front of every daemon) does not answer the
 * JSON-RPC request after a non-2xx it cannot parse (see auth-gate.ts), so an
 * oversized message_send used to hang the tool call instead of failing with a
 * reason.
 */

export const MCP_BODY_LIMIT_BYTES = 20 * 1024 * 1024;
const TAIL_BYTES = 4096;

function limitText(limit: number): string {
	return `${Math.round(limit / (1024 * 1024))} MB`;
}

function tooLargeMessage(bytes: number, limit: number): string {
	const mb = (bytes / (1024 * 1024)).toFixed(1);
	return `gmail-mcp: this request is ${mb} MB, over the ${limitText(limit)} limit, so nothing was sent. `
		+ 'Pass large attachments as {path} instead of base64 content.';
}

/**
 * The JSON-RPC id from the end of a request body. The MCP SDK writes `id` as
 * the last key of every request, so it sits at the very end even when the
 * body is too big to read whole. Anything else gives null.
 */
export function idFromTail(tail: string): string | number | null {
	const m = /"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")\s*\}\s*$/.exec(tail);
	if (!m?.[1]) {
		return null;
	}

	try {
		const id: unknown = JSON.parse(m[1]);
		return typeof id === 'string' || typeof id === 'number' ? id : null;
	} catch {
		return null;
	}
}

/**
 * Ahead of express.json: a POST /mcp whose Content-Length is over the limit is
 * read here (keeping only its last few KB) and answered with a JSON-RPC error
 * carrying the request's own id, so the client gets a tool error at once.
 */
export function oversizeMcpGuard(limit: number = MCP_BODY_LIMIT_BYTES) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const length = Number(req.headers['content-length']);
		if (req.method !== 'POST' || req.path !== '/mcp' || !Number.isFinite(length) || length <= limit) {
			next();
			return;
		}

		let tail = Buffer.alloc(0);
		let seen = 0;
		req.on('data', (chunk: Buffer) => {
			seen += chunk.length;
			tail = Buffer.concat([tail, chunk]);
			if (tail.length > TAIL_BYTES) {
				tail = tail.subarray(tail.length - TAIL_BYTES);
			}
		});
		req.on('end', () => {
			res.status(200).json({
				jsonrpc: '2.0',
				error: {code: -32600, message: tooLargeMessage(Math.max(seen, length), limit)},
				id: idFromTail(tail.toString('utf8')),
			});
		});
		req.on('error', () => {
			if (!res.headersSent) {
				res.status(400).json({jsonrpc: '2.0', error: {code: -32600, message: 'gmail-mcp: request body could not be read'}, id: null});
			}
		});
	};
}

type BodyError = Error & {type?: string; status?: number; statusCode?: number};

/**
 * Last in the chain: a body-parser error (bad JSON, too large without a
 * Content-Length, too many form fields) becomes JSON. On /mcp it is a JSON-RPC
 * error (the id cannot be known once parsing failed); elsewhere an OAuth-style
 * error body with the parser's own status.
 */
export function bodyErrorHandler(limit: number = MCP_BODY_LIMIT_BYTES) {
	return (err: BodyError, req: Request, res: Response, next: NextFunction): void => {
		const status = err.status ?? err.statusCode ?? 500;
		if (res.headersSent || typeof err.type !== 'string' || status < 400 || status >= 500) {
			next(err);
			return;
		}

		const message = err.type === 'entity.too.large'
			? tooLargeMessage(Number(req.headers['content-length']) || limit + 1, limit)
			: `gmail-mcp: the request body was refused (${err.message})`;
		if (req.path === '/mcp') {
			const code = err.type === 'entity.parse.failed' ? -32700 : -32600;
			res.status(200).json({jsonrpc: '2.0', error: {code, message}, id: null});
			return;
		}

		res.status(status).json({error: 'invalid_request', error_description: message});
	};
}
