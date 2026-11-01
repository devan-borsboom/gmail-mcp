import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {setLabel} from './scheduled.js';
import {
	assertNotSending, decodeRaw, getRawDraft, markerOf, mountainTime, rewriteMarker,
} from '../utils/schedule.js';

type RawDraft = Awaited<ReturnType<typeof getRawDraft>>;

const inputSchema = strictSchemaWithAliases({
	draftId: z.string().describe('The ID of the draft to send'),
}, {});

const outputSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	labelIds: z.array(z.string()).optional(),
});

/**
 * The marker was stripped before the send, so a failed send would otherwise
 * leave a plain draft the Apps Script never sends. Gmail answered with an error,
 * so the send did not happen: put the marker back. A timeout or network failure
 * may still have sent it, so the marker stays off rather than risk a second send.
 */
async function restoreAfterFailedSend(token: string, draft: RawDraft, marker: Date, error: unknown): Promise<string> {
	const reason = error instanceof Error ? error.message : String(error);
	if (reason.startsWith('Gmail API error:')) {
		try {
			const {messageId} = await rewriteMarker(token, draft, marker);
			await setLabel(token, messageId, true); // best effort; the header is what the script reads
			return `${reason}\nThe send failed, so the draft is still scheduled for ${mountainTime(marker)}.`;
		} catch (restoreError) {
			return `${reason}\nThe send failed and the schedule could not be put back (${restoreError instanceof Error ? restoreError.message : String(restoreError)}), so the draft is no longer scheduled. Check Drafts and reschedule it with draft_schedule or scheduled_update.`;
		}
	}

	return `${reason}\nThe schedule marker was already removed, so if this draft is still in Drafts it is no longer scheduled. Check Sent first; if it did not go, send or reschedule it.`;
}

/**
 * The strip failed, so the send was never attempted. A timeout or 5xx may
 * still have applied the strip, which would leave a plain draft the Apps Script
 * never sends, so write the marker back: nothing went out, so this cannot send twice.
 */
async function restoreAfterFailedStrip(token: string, draft: RawDraft, marker: Date, error: unknown): Promise<string> {
	const reason = error instanceof Error ? error.message : String(error);
	try {
		const {messageId} = await rewriteMarker(token, draft, marker);
		await setLabel(token, messageId, true); // best effort; the header is what the script reads
		return `${reason}\nThe email was not sent. It is still scheduled for ${mountainTime(marker)}.`;
	} catch (restoreError) {
		return `${reason}\nThe email was not sent, and the schedule could not be confirmed (${restoreError instanceof Error ? restoreError.message : String(restoreError)}), so the draft may no longer be scheduled. Check Drafts and reschedule it with draft_schedule or scheduled_update.`;
	}
}

export function registerDraftSend(server: McpServer, config: Config): void {
	server.registerTool(
		'draft_send',
		{
			title: 'Send draft',
			description: 'Send an existing draft',
			inputSchema,
			outputSchema,
		},
		async ({draftId}) => {
			// Sending a scheduled draft now: strip its marker first so the
			// recipient never sees the internal header.
			const draft = await getRawDraft(config.token, draftId);
			const marker = markerOf(decodeRaw(draft.message.raw));
			if (marker) {
				assertNotSending(marker);
				try {
					await rewriteMarker(config.token, draft, undefined);
				} catch (error) {
					throw new Error(await restoreAfterFailedStrip(config.token, draft, marker, error));
				}
			}

			let result: unknown;
			try {
				result = await makeGmailApiCall('POST', '/users/me/drafts/send', config.token, {
					id: draftId,
				});
			} catch (error) {
				if (!marker) {
					throw error;
				}

				throw new Error(await restoreAfterFailedSend(config.token, draft, marker, error));
			}

			return jsonResult(outputSchema.parse(result));
		},
	);
}
