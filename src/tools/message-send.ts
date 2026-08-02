import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {
	type ResolvedAttachment, appendMimeBody, attachmentSchema, resolveAttachment, safeHeaderString,
} from '../utils/mime.js';
import {buildThreadHeaders, foldHeader} from '../utils/msgid.js';
import {fetchThreadHeaders} from '../utils/thread-context.js';

const inputSchema = strictSchemaWithAliases({
	to: safeHeaderString.describe('Recipient email address(es), comma-separated for multiple'),
	subject: safeHeaderString.describe('Email subject'),
	body: z.string().describe('Email body (plain text or HTML)'),
	isHtml: z.boolean().optional().describe('Send as HTML. If true, body is treated as HTML.'),
	cc: safeHeaderString.optional().describe('CC recipients, comma-separated'),
	bcc: safeHeaderString.optional().describe('BCC recipients, comma-separated'),
	from: safeHeaderString.optional().describe('Sender email address (for send-as aliases)'),
	threadId: z.string().optional().describe('Thread ID to reply to'),
	inReplyTo: z.string().optional().describe('Message-ID header of the message being replied to, e.g. <abc@mail.gmail.com>'),
	references: z.string().optional().describe('The References header of the message being replied to. Pass it verbatim and the parent Message-ID is appended automatically, so the recipient sees a correctly threaded reply. Omitting this on a multi-message thread breaks threading for the recipient.'),
	attachments: z.array(attachmentSchema).optional().describe('Optional file attachments. Each may be {path} (preferred) or {filename, mimeType, content} where content is base64.'),
}, {});

const outputSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	labelIds: z.array(z.string()).optional(),
	threadingWarning: z.string().optional(),
});

/**
 * Create an RFC 2822 formatted email message and base64url encode it.
 */
function createRawMessage(options: {
	to: string;
	subject: string;
	body: string;
	isHtml?: boolean;
	cc?: string;
	bcc?: string;
	from?: string;
	inReplyTo?: string;
	references?: string;
	attachments?: ResolvedAttachment[];
}): {raw: string; warning?: string} {
	const lines: string[] = [];

	if (options.from) {
		lines.push(`From: ${options.from}`);
	}

	lines.push(`To: ${options.to}`);
	if (options.cc) {
		lines.push(`Cc: ${options.cc}`);
	}

	if (options.bcc) {
		lines.push(`Bcc: ${options.bcc}`);
	}

	lines.push(`Subject: ${options.subject}`);

	// Sanitise and accumulate rather than echoing the raw parameter: callers
	// have shipped HTML-escaped ids (&lt;...&gt;), which silently break
	// threading for the recipient. See utils/msgid.ts.
	const thread = buildThreadHeaders(options.inReplyTo, options.references);
	if (thread.inReplyTo) {
		lines.push(`In-Reply-To: ${thread.inReplyTo}`);
	}

	if (thread.references) {
		lines.push(foldHeader('References', thread.references));
	}

	appendMimeBody(lines, options.body, options.attachments, options.isHtml);

	const message = lines.join('\r\n');

	const raw = Buffer.from(message)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

	return {raw, ...(thread.warning && {warning: thread.warning})};
}

export function registerMessageSend(server: McpServer, config: Config): void {
	server.registerTool(
		'message_send',
		{
			title: 'Send message',
			description: 'Send an email message (plain text or HTML), optionally with file attachments. Can also be used to reply to existing threads.',
			inputSchema,
			outputSchema,
		},
		async ({to, subject, body, isHtml, cc, bcc, from, threadId, inReplyTo, references, attachments}) => {
			const resolvedAttachments = attachments?.map(resolveAttachment);

			// A caller that supplies threadId but omits references would otherwise
			// emit a single-id chain and break threading for the recipient. Recover
			// the chain from the thread rather than trusting the caller to pass it.
			// Blank is treated as absent: `?? ` alone would keep an empty string and
			// discard the recovered value the lookup just paid for.
			const givenInReplyTo = inReplyTo?.trim() ? inReplyTo : undefined;
			const givenReferences = references?.trim() ? references : undefined;
			const recovered = threadId && !givenReferences
				? await fetchThreadHeaders(threadId, config.token, givenInReplyTo)
				: {};
			const effectiveInReplyTo = givenInReplyTo ?? recovered.inReplyTo;
			const effectiveReferences = givenReferences ?? recovered.references;

			const {raw, warning} = createRawMessage({
				to,
				subject,
				body,
				...(isHtml && {isHtml}),
				...(cc && {cc}),
				...(bcc && {bcc}),
				...(from && {from}),
				...(effectiveInReplyTo && {inReplyTo: effectiveInReplyTo}),
				...(effectiveReferences && {references: effectiveReferences}),
				...(resolvedAttachments && {attachments: resolvedAttachments}),
			});

			const requestBody: {raw: string; threadId?: string} = {raw};
			if (threadId) {
				requestBody.threadId = threadId;
			}

			const result = await makeGmailApiCall('POST', '/users/me/messages/send', config.token, requestBody);
			const threadingWarning = [recovered.warning, warning].filter(Boolean).join(' ');
			return jsonResult(outputSchema.parse({
				...(result as Record<string, unknown>),
				...(threadingWarning && {threadingWarning}),
			}));
		},
	);
}
