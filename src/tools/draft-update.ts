import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {
	type ResolvedAttachment, appendMimeBody, attachmentSchema, resolveAttachment, safeHeaderString,
} from '../utils/mime.js';
import {decodeRaw, getRawDraft, markerOf} from '../utils/schedule.js';

const inputSchema = strictSchemaWithAliases({
	draftId: z.string().describe('The ID of the draft to update'),
	to: safeHeaderString.optional().describe('Recipient email address(es), comma-separated. Omit to keep the current recipients.'),
	subject: safeHeaderString.optional().describe('Email subject. Omit to keep the current subject.'),
	body: z.string().optional().describe('Email body (plain text or HTML). Omit to keep the current body.'),
	isHtml: z.boolean().optional().describe('Treat body as HTML. Omit to keep the draft\'s current format.'),
	cc: safeHeaderString.optional().describe('CC email address(es), comma-separated. Omit to keep the current CC.'),
	bcc: safeHeaderString.optional().describe('BCC email address(es), comma-separated. Omit to keep the current BCC.'),
	from: safeHeaderString.optional().describe('Sender email address (for send-as aliases). Omit to keep the current sender.'),
	attachments: z.array(attachmentSchema).optional().describe('File attachments. When given, they REPLACE the draft\'s current attachments; omit to keep them. Each may be {path} (preferred) or {filename, mimeType, content} where content is base64.'),
}, {});

const outputSchema = z.object({
	id: z.string(),
	message: z.object({
		id: z.string(),
		threadId: z.string(),
	}).optional(),
	senderWarning: z.string().optional(),
});

/** A header with its folded continuation lines, kept verbatim. */
type HeaderGroup = {name: string; lines: string[]};

function splitHead(head: string): HeaderGroup[] {
	const groups: HeaderGroup[] = [];
	for (const line of head.split(/\r?\n/)) {
		const last = groups.at(-1);
		if (/^[ \t]/.test(line) && last) {
			last.lines.push(line);
		} else if (line !== '') {
			groups.push({name: (line.split(':')[0] ?? '').trim().toLowerCase(), lines: [line]});
		}
	}

	return groups;
}

function headerValue(groups: HeaderGroup[], name: string): string | undefined {
	const found = groups.find((g) => g.name === name);
	return found?.lines.map((l, i) => (i === 0 ? l.slice(l.indexOf(':') + 1) : l)).join(' ').trim();
}

/** The parts of a multipart body, each a complete MIME entity (headers + content). */
function splitMultipart(content: string, boundary: string): string[] {
	const parts: string[] = [];
	for (const segment of content.split(`--${boundary}`).slice(1)) {
		if (segment.startsWith('--')) {
			break;
		}

		parts.push(segment.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n$/, ''));
	}

	return parts;
}

/**
 * Split a message's content into its body entity and its attachment entities.
 * A multipart/mixed message's first part is the body and the rest are
 * attachments; anything else is all body. The body entity carries the
 * message's own Content-* headers, so it can be reused as a MIME part.
 */
function splitContent(groups: HeaderGroup[], content: string): {bodyEntity: string; attachmentEntities: string[]} {
	const type = headerValue(groups, 'content-type') ?? '';
	const boundary = /boundary="?([^";\s]+)"?/i.exec(type)?.[1];
	if (/^multipart\/mixed/i.test(type) && boundary) {
		const parts = splitMultipart(content, boundary);
		if (parts.length > 0) {
			return {bodyEntity: parts[0]!, attachmentEntities: parts.slice(1)};
		}
	}

	const contentHeaders = groups.filter((g) => g.name.startsWith('content-')).flatMap((g) => g.lines);
	return {bodyEntity: [...contentHeaders, '', content].join('\r\n'), attachmentEntities: []};
}

function entityIsHtml(entity: string): boolean {
	const head = entity.split(/\r?\n\r?\n/)[0] ?? '';
	const type = headerValue(splitHead(head), 'content-type') ?? 'text/plain';
	if (/^text\/html/i.test(type)) {
		return true;
	}

	return /^multipart\/alternative/i.test(type) && /content-type:\s*text\/html/i.test(entity);
}

function attachmentEntity(att: ResolvedAttachment): string {
	const lines: string[] = [];
	appendMimeBody(lines, '', [att]);
	// appendMimeBody wraps in multipart/mixed; take only the attachment part.
	const boundary = /boundary="([^"]+)"/.exec(lines[1] ?? '')![1]!;
	return splitMultipart(lines.join('\r\n'), boundary)[1]!;
}

const CONSULT_FROM = 'devan@borsboomconsulting.com';
const CONSULT_MARKER = 'Borsboom Consulting | AI for Professional Practices';

/**
 * A body-only edit keeps the draft's sender, which the PreToolUse signature
 * gate cannot see: it reads a consulting marker in the new body as a consulting
 * draft and anything else as a work draft. Warn when the kept sender says
 * otherwise, so the gate's guess is never the last word on the identity.
 */
export function keptSenderWarning(original: string, body: string): string | undefined {
	const head = /\r?\n\r?\n/.exec(original);
	const fromHeader = (headerValue(splitHead(head ? original.slice(0, head.index) : original), 'from') ?? '').toLowerCase();
	const sender = /<([^>]*)>/.exec(fromHeader)?.[1]?.trim() ?? fromHeader;
	const consultingSender = sender.includes(CONSULT_FROM);
	const consultingBody = (body.split('gmail_quote')[0] ?? '').includes(CONSULT_MARKER);
	if (consultingSender && !consultingBody) {
		return `This draft keeps its sender ${CONSULT_FROM}, but the new body is not signed with the Borsboom Consulting block, so the signature check read it as a work email. Re-sign it with the consulting block from gmail-send, or pass from: "Devan Borsboom <devan@yeticonnect.com>", before draft_send.`;
	}

	if (!consultingSender && consultingBody) {
		return `This draft keeps its sender ${sender || 'the account default'}, but the new body carries the Borsboom Consulting signature. Pass from: "Devan Borsboom <${CONSULT_FROM}>" with draft_update, or re-sign the body, before draft_send.`;
	}

	return undefined;
}

/**
 * Rebuild a draft, changing only what the caller passed. drafts.update
 * replaces the whole message, so everything else (other headers, reply
 * threading, body, format, attachments) is carried over from the current one.
 */
export function updateMessage(original: string, changes: {
	to?: string;
	subject?: string;
	body?: string;
	isHtml?: boolean;
	cc?: string;
	bcc?: string;
	from?: string;
	attachments?: ResolvedAttachment[];
}): string {
	const separator = /\r?\n\r?\n/.exec(original);
	const head = separator ? original.slice(0, separator.index) : original;
	const content = separator ? original.slice(separator.index + separator[0].length) : '';
	const groups = splitHead(head);

	const overrides: [string, string | undefined][] = [
		['from', changes.from], ['to', changes.to], ['subject', changes.subject], ['cc', changes.cc], ['bcc', changes.bcc],
	];
	const label: Record<string, string> = {
		from: 'From', to: 'To', subject: 'Subject', cc: 'Cc', bcc: 'Bcc',
	};
	const replaced = new Set(overrides.filter(([, v]) => v !== undefined).map(([n]) => n));
	const newHeaderLines = overrides.filter(([, v]) => v !== undefined).map(([n, v]) => `${label[n]!}: ${v!}`);

	const rebuildBody = changes.body !== undefined || changes.attachments !== undefined || changes.isHtml !== undefined;
	if (!rebuildBody) {
		const kept = groups.filter((g) => !replaced.has(g.name)).flatMap((g) => g.lines);
		return [...newHeaderLines, ...kept].join('\r\n') + (separator ? separator[0] + content : '');
	}

	const {bodyEntity: oldBody, attachmentEntities: oldAttachments} = splitContent(groups, content);
	const isHtml = changes.isHtml ?? entityIsHtml(oldBody);
	let bodyEntity = oldBody;
	if (changes.body !== undefined) {
		bodyEntity = [`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`, 'Content-Transfer-Encoding: 7bit', '', changes.body].join('\r\n');
	} else if (changes.isHtml !== undefined && /^content-type:\s*text\/(plain|html)/im.test(oldBody.split(/\r?\n\r?\n/)[0] ?? '')) {
		bodyEntity = oldBody.replace(/^(content-type:\s*)text\/(plain|html)/im, `$1${isHtml ? 'text/html' : 'text/plain'}`);
	}

	const attachments = changes.attachments
		? changes.attachments.map(attachmentEntity)
		: oldAttachments;

	const kept = groups
		.filter((g) => !replaced.has(g.name) && !g.name.startsWith('content-') && g.name !== 'mime-version')
		.flatMap((g) => g.lines);
	const lines = [...newHeaderLines, ...kept, 'MIME-Version: 1.0'];

	if (attachments.length === 0) {
		lines.push(bodyEntity);
		return lines.join('\r\n');
	}

	const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2)}`;
	lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');
	for (const entity of [bodyEntity, ...attachments]) {
		lines.push(`--${boundary}`, entity, '');
	}

	lines.push(`--${boundary}--`);
	return lines.join('\r\n');
}

export function registerDraftUpdate(server: McpServer, config: Config): void {
	server.registerTool(
		'draft_update',
		{
			title: 'Update draft',
			description: 'Update an existing draft. Only the fields passed change: recipients, subject, body, format, reply threading and attachments that are omitted are kept as they are.',
			inputSchema,
			outputSchema,
		},
		async ({draftId, to, subject, body, isHtml, cc, bcc, from, attachments}) => {
			const resolvedAttachments = attachments?.map(resolveAttachment);

			// On a scheduled draft an edit would race the Apps Script sending it
			// unattended (and a body edit there is easy to get wrong). So refuse.
			const current = await getRawDraft(config.token, draftId);
			const original = decodeRaw(current.message.raw);
			if (markerOf(original)) {
				throw new Error('This draft is scheduled. To change it, cancel it with scheduled_cancel (delete: true) and schedule the new version with draft_schedule; to change only the time, use scheduled_update.');
			}

			const email = updateMessage(original, {
				...(to !== undefined && {to}),
				...(subject !== undefined && {subject}),
				...(body !== undefined && {body}),
				...(isHtml !== undefined && {isHtml}),
				...(cc !== undefined && {cc}),
				...(bcc !== undefined && {bcc}),
				...(from !== undefined && {from}),
				...(resolvedAttachments && {attachments: resolvedAttachments}),
			});
			const encodedEmail = Buffer.from(email).toString('base64url');

			const result = await makeGmailApiCall('PUT', `/users/me/drafts/${draftId}`, config.token, {
				id: draftId,
				message: {raw: encodedEmail, ...(current.message.threadId && {threadId: current.message.threadId})},
			});
			const senderWarning = from === undefined && body !== undefined ? keptSenderWarning(original, body) : undefined;
			const parsed = outputSchema.parse(result);
			return jsonResult(senderWarning ? {...parsed, senderWarning} : parsed);
		},
	);
}
