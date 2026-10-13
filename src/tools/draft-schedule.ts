import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {attachmentSchema, resolveAttachment, safeHeaderString} from '../utils/mime.js';
import {fetchThreadHeaders} from '../utils/thread-context.js';
import {ensureScheduleLabel, mountainTime, parseSendAt, sendAtSchema} from '../utils/schedule.js';
import {createRawMessage} from './draft-create.js';

const inputSchema = strictSchemaWithAliases({
	to: safeHeaderString.describe('Recipient email address(es), comma-separated for multiple'),
	subject: safeHeaderString.describe('Email subject'),
	body: z.string().describe('Email body (plain text or HTML)'),
	sendAt: sendAtSchema,
	isHtml: z.boolean().optional().describe('Treat body as HTML. If true, the email renders as HTML.'),
	cc: safeHeaderString.optional().describe('CC recipients, comma-separated'),
	bcc: safeHeaderString.optional().describe('BCC recipients, comma-separated'),
	from: safeHeaderString.optional().describe('Sender email address (for send-as aliases)'),
	threadId: z.string().optional().describe('Thread ID if this is a reply'),
	inReplyTo: z.string().optional().describe('Message-ID header of the message being replied to, e.g. <abc@mail.gmail.com>'),
	references: z.string().optional().describe('The References header of the message being replied to. Pass it verbatim and the parent Message-ID is appended automatically.'),
	attachments: z.array(attachmentSchema).optional().describe('Optional file attachments. Each may be {path} (preferred) or {filename, mimeType, content} where content is base64.'),
}, {});

const outputSchema = z.object({
	draftId: z.string(),
	messageId: z.string(),
	threadId: z.string(),
	sendAt: z.string(),
	sendAtLocal: z.string(),
	labelWarning: z.string().optional(),
	threadingWarning: z.string().optional(),
});

export function registerDraftSchedule(server: McpServer, config: Config): void {
	server.registerTool(
		'draft_schedule',
		{
			title: 'Schedule email',
			description: 'Schedule an email to send later. Saves it as a draft marked with the send time and the Scheduled-Send label; the Apps Script in this Google account sends it within about 5 minutes of sendAt. Treat this exactly like sending: the recipient, wording AND time need approval first. Cancel with scheduled_cancel, change the time with scheduled_update, see pending ones with scheduled_list.',
			inputSchema,
			outputSchema,
		},
		async ({to, subject, body, sendAt, isHtml, cc, bcc, from, threadId, inReplyTo, references, attachments}) => {
			const when = parseSendAt(sendAt);
			const resolvedAttachments = attachments?.map(resolveAttachment);

			// Same reply recovery as draft_create. See utils/thread-context.ts.
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
				scheduleAt: when,
				...(isHtml && {isHtml}),
				...(cc && {cc}),
				...(bcc && {bcc}),
				...(from && {from}),
				...(effectiveInReplyTo && {inReplyTo: effectiveInReplyTo}),
				...(effectiveReferences && {references: effectiveReferences}),
				...(resolvedAttachments && {attachments: resolvedAttachments}),
			});

			const requestBody: {message: {raw: string; threadId?: string}} = {message: {raw}};
			if (threadId) {
				requestBody.message.threadId = threadId;
			}

			const draft = await makeGmailApiCall('POST', '/users/me/drafts', config.token, requestBody) as {
				id: string; message: {id: string; threadId: string};
			};

			// The label is a convenience; the header alone is enough for the
			// script to send. A labelling failure is reported, never fatal.
			let labelWarning: string | undefined;
			try {
				const labelId = await ensureScheduleLabel(config.token);
				await makeGmailApiCall('POST', `/users/me/messages/${draft.message.id}/modify`, config.token, {
					addLabelIds: [labelId],
				});
			} catch (error) {
				labelWarning = `Scheduled, but the Scheduled-Send label could not be applied: ${error instanceof Error ? error.message : String(error)}`;
			}

			const threadingWarning = [recovered.warning, warning].filter(Boolean).join(' ');
			return jsonResult(outputSchema.parse({
				draftId: draft.id,
				messageId: draft.message.id,
				threadId: draft.message.threadId,
				sendAt: when.toISOString(),
				sendAtLocal: mountainTime(when),
				...(labelWarning && {labelWarning}),
				...(threadingWarning && {threadingWarning}),
			}));
		},
	);
}
