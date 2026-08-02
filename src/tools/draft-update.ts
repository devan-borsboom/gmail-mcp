import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {
	appendMimeBody, attachmentSchema, resolveAttachment, safeHeaderString,
} from '../utils/mime.js';

const inputSchema = strictSchemaWithAliases({
	draftId: z.string().describe('The ID of the draft to update'),
	to: safeHeaderString.optional().describe('Recipient email address(es), comma-separated'),
	subject: safeHeaderString.optional().describe('Email subject'),
	body: z.string().optional().describe('Email body (plain text or HTML)'),
	isHtml: z.boolean().optional().describe('Treat body as HTML. If true, the draft renders as HTML.'),
	cc: safeHeaderString.optional().describe('CC email address(es), comma-separated'),
	bcc: safeHeaderString.optional().describe('BCC email address(es), comma-separated'),
	from: safeHeaderString.optional().describe('Sender email address (for send-as aliases)'),
	attachments: z.array(attachmentSchema).optional().describe('Optional file attachments. Each may be {path} (preferred) or {filename, mimeType, content} where content is base64.'),
}, {});

const outputSchema = z.object({
	id: z.string(),
	message: z.object({
		id: z.string(),
		threadId: z.string(),
	}).optional(),
});

export function registerDraftUpdate(server: McpServer, config: Config): void {
	server.registerTool(
		'draft_update',
		{
			title: 'Update draft',
			description: 'Update an existing draft',
			inputSchema,
			outputSchema,
		},
		async ({draftId, to, subject, body, isHtml, cc, bcc, from, attachments}) => {
			const resolvedAttachments = attachments?.map(resolveAttachment);

			const lines = [
				...(from ? [`From: ${from}`] : []),
				...(to ? [`To: ${to}`] : []),
				...(subject ? [`Subject: ${subject}`] : []),
				...(cc ? [`Cc: ${cc}`] : []),
				...(bcc ? [`Bcc: ${bcc}`] : []),
			];

			appendMimeBody(lines, body ?? '', resolvedAttachments, isHtml);

			const email = lines.join('\r\n');
			const encodedEmail = Buffer.from(email).toString('base64url');

			const result = await makeGmailApiCall('PUT', `/users/me/drafts/${draftId}`, config.token, {
				message: {raw: encodedEmail},
			});
			return jsonResult(outputSchema.parse(result));
		},
	);
}
