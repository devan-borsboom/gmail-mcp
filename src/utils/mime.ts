import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {z} from 'zod';

const safeHeaderString = z.string().regex(/^[^\r\n]*$/, 'Must not contain newline characters');

// Realpath the roots too, so the comparison below is symlink-to-symlink
// consistent (e.g. if ~/Documents itself is a link into a synced volume).
const ALLOWED_ROOTS = ['Downloads', 'Documents', 'Desktop', 'yeticonnect-team-data', 'code', 'claude-memory']
	.map((d) => path.join(os.homedir(), d))
	.map((d) => {
		try {
			return fs.realpathSync(d);
		} catch {
			return d;
		}
	});

const MIME_MAP: Record<string, string> = {
	'.pdf': 'application/pdf',
	'.html': 'text/html',
	'.htm': 'text/html',
	'.txt': 'text/plain',
	'.csv': 'text/csv',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.zip': 'application/zip',
	'.json': 'application/json',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'.doc': 'application/msword',
	'.xls': 'application/vnd.ms-excel',
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
};

export const attachmentSchema = z.union([
	z.object({
		path: z.string().describe('Absolute local file path. Must resolve under ~/Downloads, ~/Documents, ~/Desktop, ~/yeticonnect-team-data, ~/code, or ~/claude-memory.'),
		filename: safeHeaderString.optional().describe('Override filename in the email (defaults to basename of path)'),
		mimeType: safeHeaderString.optional().describe('Override MIME type (defaults to extension-based guess)'),
	}),
	z.object({
		filename: safeHeaderString.transform((s) => s.replaceAll('"', '')).describe('Attachment filename'),
		mimeType: safeHeaderString.describe('MIME type (e.g., application/pdf)'),
		content: z.string().describe('Base64-encoded file data'),
	}),
]);

export type Attachment = z.infer<typeof attachmentSchema>;

export type ResolvedAttachment = {
	filename: string;
	mimeType: string;
	content: string;
};

function wrapBase64(b64: string, width = 76): string {
	const lines: string[] = [];
	for (let i = 0; i < b64.length; i += width) {
		lines.push(b64.slice(i, i + width));
	}

	return lines.join('\r\n');
}

export function resolveAttachment(att: Attachment): ResolvedAttachment {
	if ('content' in att) {
		return {
			filename: att.filename,
			mimeType: att.mimeType,
			content: att.content.replace(/\r?\n/g, ''),
		};
	}

	const expanded = att.path.startsWith('~')
		? path.join(os.homedir(), att.path.slice(1).replace(/^[\\/]/, ''))
		: att.path;

	// path.resolve() is purely lexical: it collapses ".." but does NOT follow
	// symlinks. A symlink dropped inside an allowed root (say ~/Downloads/x ->
	// ~/.ssh/id_rsa) would otherwise pass this gate and be read and emailed.
	// realpath is what actually confines us to the allowlist. Fall back to the
	// lexical path when the file does not exist so the caller still gets a
	// clear ENOENT from readFileSync rather than a confusing allowlist error.
	const lexical = path.resolve(expanded);
	let resolved = lexical;
	try {
		resolved = fs.realpathSync(lexical);
	} catch {
		resolved = lexical;
	}

	const insideAllowed = ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep));
	if (!insideAllowed) {
		throw new Error(`Attachment path not allowed: ${resolved}. Must be under one of: ${ALLOWED_ROOTS.join(', ')}`);
	}

	const buf = fs.readFileSync(resolved);
	const ext = path.extname(resolved).toLowerCase();
	return {
		filename: att.filename ?? path.basename(resolved),
		mimeType: att.mimeType ?? MIME_MAP[ext] ?? 'application/octet-stream',
		content: buf.toString('base64'),
	};
}

export function appendMimeBody(
	lines: string[],
	body: string,
	attachments?: ResolvedAttachment[],
	isHtml?: boolean,
): void {
	const bodyContentType = isHtml ? 'text/html' : 'text/plain';

	if (attachments && attachments.length > 0) {
		const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2)}`;
		lines.push('MIME-Version: 1.0');
		lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
		lines.push('');

		lines.push(`--${boundary}`);
		lines.push(`Content-Type: ${bodyContentType}; charset=utf-8`);
		lines.push('Content-Transfer-Encoding: 7bit');
		lines.push('');
		lines.push(body);
		lines.push('');

		for (const att of attachments) {
			lines.push(`--${boundary}`);
			lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
			lines.push('Content-Transfer-Encoding: base64');
			lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
			lines.push('');
			lines.push(wrapBase64(att.content));
			lines.push('');
		}

		lines.push(`--${boundary}--`);
	} else {
		lines.push(`Content-Type: ${bodyContentType}; charset=utf-8`);
		lines.push('');
		lines.push(body);
	}
}
