import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {
	SCHEDULE_HEADER, SCHEDULE_LABEL, decodeRaw, encodeRaw, ensureScheduleLabel, findScheduleLabel,
	parseSendAt, readScheduleMarker, sendAtSchema, setScheduleMarker,
} from '../utils/schedule.js';

// A scheduled draft this many minutes past due means the Apps Script is not
// running in that account.
export const OVERDUE_MINUTES = 15;

type DraftRef = {id: string; message?: {id: string; threadId: string}};
type MessageMeta = {
	id: string;
	threadId: string;
	labelIds?: string[];
	payload?: {headers?: {name: string; value: string}[]};
};

function header(meta: MessageMeta, name: string): string | undefined {
	return meta.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Rewrite a draft's marker header: set it to `when`, or remove it when `when`
 * is undefined. drafts.update replaces the whole message, so the raw source is
 * fetched, edited in the header block only, and written back with its thread.
 */
async function rewriteMarker(token: string, draftId: string, when: Date | undefined): Promise<{messageId: string; threadId: string}> {
	const draft = await makeGmailApiCall('GET', `/users/me/drafts/${encodeURIComponent(draftId)}?format=raw`, token) as {
		id: string; message: {id: string; threadId: string; raw: string};
	};
	const raw = encodeRaw(setScheduleMarker(decodeRaw(draft.message.raw), when));
	const updated = await makeGmailApiCall('PUT', `/users/me/drafts/${encodeURIComponent(draftId)}`, token, {
		id: draftId,
		message: {raw, threadId: draft.message.threadId},
	}) as {id: string; message: {id: string; threadId: string}};
	return {messageId: updated.message.id, threadId: updated.message.threadId};
}

async function setLabel(token: string, messageId: string, on: boolean): Promise<string | undefined> {
	try {
		const labelId = on ? await ensureScheduleLabel(token) : await findScheduleLabel(token);
		if (!labelId) {
			return undefined;
		}

		await makeGmailApiCall('POST', `/users/me/messages/${messageId}/modify`, token, on ? {addLabelIds: [labelId]} : {removeLabelIds: [labelId]});
		return undefined;
	} catch (error) {
		return `The ${SCHEDULE_LABEL} label could not be ${on ? 'applied' : 'removed'}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

const listOutput = z.object({
	scheduled: z.array(z.object({
		draftId: z.string(),
		messageId: z.string(),
		threadId: z.string(),
		sendAt: z.string(),
		to: z.string().optional(),
		subject: z.string().optional(),
		overdue: z.boolean(),
	})),
	scannedDrafts: z.number(),
	overdueCount: z.number(),
	truncated: z.boolean(),
});

export function registerScheduledList(server: McpServer, config: Config): void {
	server.registerTool(
		'scheduled_list',
		{
			title: 'List scheduled emails',
			description: `List emails waiting to be sent by schedule (drafts carrying the ${SCHEDULE_HEADER} marker), soonest first. overdue=true means it is ${OVERDUE_MINUTES}+ minutes past its time, a sign the Apps Script in this account is not running.`,
			inputSchema: strictSchemaWithAliases({
				maxDrafts: z.number().min(1).max(500).default(200).describe('How many drafts to scan at most'),
			}, {}),
			outputSchema: listOutput,
			annotations: {readOnlyHint: true},
		},
		async ({maxDrafts}) => {
			// Scan drafts rather than search the label: the header is the
			// source of truth, and a draft whose label failed must still show.
			const drafts: DraftRef[] = [];
			let pageToken: string | undefined;
			do {
				const params = new URLSearchParams({maxResults: String(Math.min(100, maxDrafts - drafts.length))});
				if (pageToken) {
					params.set('pageToken', pageToken);
				}

				// eslint-disable-next-line no-await-in-loop
				const page = await makeGmailApiCall('GET', `/users/me/drafts?${params.toString()}`, config.token) as {drafts?: DraftRef[]; nextPageToken?: string};
				drafts.push(...(page.drafts ?? []));
				pageToken = page.nextPageToken;
			} while (pageToken && drafts.length < maxDrafts);

			const metaParams = new URLSearchParams({format: 'metadata'});
			for (const h of [SCHEDULE_HEADER, 'To', 'Subject']) {
				metaParams.append('metadataHeaders', h);
			}

			const now = Date.now();
			const metas = await Promise.all(drafts.filter((d) => d.message?.id).map(async (d) => ({
				draft: d,
				meta: await makeGmailApiCall('GET', `/users/me/messages/${d.message!.id}?${metaParams.toString()}`, config.token) as MessageMeta,
			})));

			const scheduled = metas.flatMap(({draft, meta}) => {
				const when = readScheduleMarker(meta.payload?.headers);
				if (!when) {
					return [];
				}

				const to = header(meta, 'To');
				const subject = header(meta, 'Subject');
				return [{
					draftId: draft.id,
					messageId: meta.id,
					threadId: meta.threadId,
					sendAt: when.toISOString(),
					...(to !== undefined && {to}),
					...(subject !== undefined && {subject}),
					overdue: now - when.getTime() > OVERDUE_MINUTES * 60 * 1000,
				}];
			}).sort((a, b) => a.sendAt.localeCompare(b.sendAt));

			return jsonResult(listOutput.parse({
				scheduled,
				scannedDrafts: drafts.length,
				overdueCount: scheduled.filter((s) => s.overdue).length,
				truncated: Boolean(pageToken),
			}));
		},
	);
}

const updateOutput = z.object({
	draftId: z.string(),
	messageId: z.string(),
	threadId: z.string(),
	sendAt: z.string(),
	labelWarning: z.string().optional(),
});

export function registerScheduledUpdate(server: McpServer, config: Config): void {
	server.registerTool(
		'scheduled_update',
		{
			title: 'Schedule an existing draft / change send time',
			description: 'Set or change the send time on an existing draft. Works on a draft already scheduled (reschedule) or a plain draft (schedules it). Treat this exactly like sending: the draft\'s recipient, wording AND the new time need approval first.',
			inputSchema: strictSchemaWithAliases({
				draftId: z.string().describe('The draft ID'),
				sendAt: sendAtSchema,
			}, {}),
			outputSchema: updateOutput,
		},
		async ({draftId, sendAt}) => {
			const when = parseSendAt(sendAt);
			const {messageId, threadId} = await rewriteMarker(config.token, draftId, when);
			const labelWarning = await setLabel(config.token, messageId, true);
			return jsonResult(updateOutput.parse({
				draftId, messageId, threadId, sendAt: when.toISOString(), ...(labelWarning && {labelWarning}),
			}));
		},
	);
}

const cancelOutput = z.object({
	draftId: z.string(),
	cancelled: z.literal(true),
	deleted: z.boolean(),
	labelWarning: z.string().optional(),
});

export function registerScheduledCancel(server: McpServer, config: Config): void {
	server.registerTool(
		'scheduled_cancel',
		{
			title: 'Cancel a scheduled email',
			description: 'Stop a scheduled email from sending. By default it stays as a normal draft; pass delete=true to delete the draft entirely.',
			inputSchema: strictSchemaWithAliases({
				draftId: z.string().describe('The draft ID'),
				delete: z.boolean().default(false).describe('Delete the draft instead of keeping it as a normal draft'),
			}, {}),
			outputSchema: cancelOutput,
		},
		async ({draftId, delete: remove}) => {
			if (remove) {
				await makeGmailApiCall('DELETE', `/users/me/drafts/${encodeURIComponent(draftId)}`, config.token);
				return jsonResult(cancelOutput.parse({draftId, cancelled: true, deleted: true}));
			}

			const {messageId} = await rewriteMarker(config.token, draftId, undefined);
			const labelWarning = await setLabel(config.token, messageId, false);
			return jsonResult(cancelOutput.parse({
				draftId, cancelled: true, deleted: false, ...(labelWarning && {labelWarning}),
			}));
		},
	);
}
