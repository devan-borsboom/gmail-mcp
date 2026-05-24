import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {
	type ResolvedAttachment, appendMimeBody, attachmentSchema, resolveAttachment,
} from '../utils/mime.js';

const inputSchema = strictSchemaWithAliases({
	to: z.string().describe('Recipient email address(es), comma-separated for multiple'),
	subject: z.string().describe('Email subject'),
	body: z.string().describe('Email body (plain text or HTML)'),
	isHtml: z.boolean().optional().describe('Send as HTML. If true, body is treated as HTML.'),
	cc: z.string().optional().describe('CC recipients, comma-separated'),
	bcc: z.string().optional().describe('BCC recipients, comma-separated'),
	from: z.string().optional().describe('Sender email address (for send-as aliases)'),
	threadId: z.string().optional().describe('Thread ID to reply to'),
	inReplyTo: z.string().optional().describe('Message-ID header of the message being replied to'),
	attachments: z.array(attachmentSchema).optional().describe('Optional file attachments. Each may be {path} (preferred) or {filename, mimeType, content} where content is base64.'),
}, {});

const outputSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	labelIds: z.array(z.string()).optional(),
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
	attachments?: ResolvedAttachment[];
}): string {
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
	if (options.inReplyTo) {
		lines.push(`In-Reply-To: ${options.inReplyTo}`);
		lines.push(`References: ${options.inReplyTo}`);
	}

	appendMimeBody(lines, options.body, options.attachments, options.isHtml);

	const message = lines.join('\r\n');

	return Buffer.from(message)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
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
		async ({to, subject, body, isHtml, cc, bcc, from, threadId, inReplyTo, attachments}) => {
			const resolvedAttachments = attachments?.map(resolveAttachment);

			const raw = createRawMessage({
				to,
				subject,
				body,
				...(isHtml && {isHtml}),
				...(cc && {cc}),
				...(bcc && {bcc}),
				...(from && {from}),
				...(inReplyTo && {inReplyTo}),
				...(resolvedAttachments && {attachments: resolvedAttachments}),
			});

			const requestBody: {raw: string; threadId?: string} = {raw};
			if (threadId) {
				requestBody.threadId = threadId;
			}

			const result = await makeGmailApiCall('POST', '/users/me/messages/send', config.token, requestBody);
			return jsonResult(outputSchema.parse(result));
		},
	);
}
