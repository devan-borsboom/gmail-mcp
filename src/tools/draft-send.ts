import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';
import {makeGmailApiCall} from '../utils/gmail-api.js';
import {jsonResult} from '../utils/response.js';
import {strictSchemaWithAliases} from '../utils/schema.js';
import {
	assertNotSending, decodeRaw, getRawDraft, markerOf, rewriteMarker,
} from '../utils/schedule.js';

const inputSchema = strictSchemaWithAliases({
	draftId: z.string().describe('The ID of the draft to send'),
}, {});

const outputSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	labelIds: z.array(z.string()).optional(),
});

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
				await rewriteMarker(config.token, draft, undefined);
			}

			const result = await makeGmailApiCall('POST', '/users/me/drafts/send', config.token, {
				id: draftId,
			});
			return jsonResult(outputSchema.parse(result));
		},
	);
}
