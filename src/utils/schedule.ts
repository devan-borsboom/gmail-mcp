// Scheduled send support.
//
// The Gmail API has no send-time option (checked against the v1 discovery
// document, revision 20261005), so a scheduled email is an ordinary draft
// carrying a marker header. A companion Apps Script running inside the same
// Google account (apps-script/scheduled-send.gs) finds due drafts, strips the
// marker and sends them. The header is the source of truth; the label only
// makes the drafts easy to find in Gmail and to query cheaply.

import {z} from 'zod';
import {makeGmailApiCall} from './gmail-api.js';

export const SCHEDULE_HEADER = 'X-Scheduled-Send';
export const SCHEDULE_LABEL = 'Scheduled-Send';

export const MIN_LEAD_MS = 2 * 60 * 1000;
export const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

// ISO 8601 with an explicit offset. A bare local time is refused: the server's
// clock zone and the caller's intended zone are not guaranteed to match.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export const sendAtSchema = z.string()
	.regex(ISO_WITH_OFFSET, 'sendAt must be ISO 8601 with a time zone offset, e.g. 2026-10-13T08:00:00-06:00')
	.describe('When to send, ISO 8601 with a time zone offset, e.g. 2026-10-13T08:00:00-06:00 for 8 AM Mountain Daylight Time. Must be 2 minutes to 365 days from now.');

/** Parse and range-check a sendAt value. Returns the instant as a Date. */
export function parseSendAt(value: string, now: Date = new Date()): Date {
	if (!ISO_WITH_OFFSET.test(value)) {
		throw new Error(`sendAt "${value}" must be ISO 8601 with a time zone offset, e.g. 2026-10-13T08:00:00-06:00`);
	}

	const when = new Date(value);
	if (Number.isNaN(when.getTime())) {
		throw new Error(`sendAt "${value}" is not a real date`);
	}

	const lead = when.getTime() - now.getTime();
	if (lead < MIN_LEAD_MS) {
		throw new Error(`sendAt ${when.toISOString()} is less than 2 minutes from now; send it directly instead`);
	}

	if (lead > MAX_LEAD_MS) {
		throw new Error(`sendAt ${when.toISOString()} is more than 365 days away`);
	}

	return when;
}

/** The marker header line, always in UTC so the script never parses a zone. */
export function scheduleHeaderLine(when: Date): string {
	return `${SCHEDULE_HEADER}: ${when.toISOString()}`;
}

/**
 * Remove every marker header (folded continuation lines included) from the
 * header block of an RFC 2822 message, and prepend a fresh one when `when` is
 * given. The body is never touched, so a body quoting the header text survives.
 */
export function setScheduleMarker(message: string, when: Date | undefined): string {
	const separator = /\r?\n\r?\n/.exec(message);
	const headEnd = separator ? separator.index : message.length;
	const head = message.slice(0, headEnd);
	const rest = message.slice(headEnd);

	const prefix = `${SCHEDULE_HEADER.toLowerCase()}:`;
	const kept: string[] = [];
	let dropping = false;
	for (const line of head.split(/\r?\n/)) {
		if (/^[ \t]/.test(line)) {
			if (!dropping) {
				kept.push(line);
			}

			continue;
		}

		dropping = line.toLowerCase().startsWith(prefix);
		if (!dropping) {
			kept.push(line);
		}
	}

	if (when) {
		kept.unshift(scheduleHeaderLine(when));
	}

	return kept.join('\r\n') + rest;
}

/** Read the marker from a header list as returned by the Gmail API. */
export function readScheduleMarker(headers: {name: string; value: string}[] | undefined): Date | undefined {
	const found = headers?.find((h) => h.name.toLowerCase() === SCHEDULE_HEADER.toLowerCase());
	if (!found) {
		return undefined;
	}

	const when = new Date(found.value.trim());
	return Number.isNaN(when.getTime()) ? undefined : when;
}

export function decodeRaw(raw: string): string {
	return Buffer.from(raw, 'base64url').toString('utf8');
}

export function encodeRaw(message: string): string {
	return Buffer.from(message, 'utf8').toString('base64url');
}

/** Find the schedule label's id, creating the label on first use. */
export async function ensureScheduleLabel(token: string): Promise<string> {
	const listed = await makeGmailApiCall('GET', '/users/me/labels', token) as {labels?: {id: string; name: string}[]};
	const existing = listed.labels?.find((l) => l.name === SCHEDULE_LABEL);
	if (existing) {
		return existing.id;
	}

	const created = await makeGmailApiCall('POST', '/users/me/labels', token, {
		name: SCHEDULE_LABEL,
		labelListVisibility: 'labelShow',
		messageListVisibility: 'show',
	}) as {id: string};
	return created.id;
}

/** Find the schedule label's id without creating it. */
export async function findScheduleLabel(token: string): Promise<string | undefined> {
	const listed = await makeGmailApiCall('GET', '/users/me/labels', token) as {labels?: {id: string; name: string}[]};
	return listed.labels?.find((l) => l.name === SCHEDULE_LABEL)?.id;
}
