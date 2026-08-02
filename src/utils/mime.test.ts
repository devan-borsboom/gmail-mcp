import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
	describe, it, expect, afterEach,
} from 'vitest';
import {appendMimeBody, resolveAttachment} from './mime.js';

const TMP_NAME = 'gmail-mcp-test-attach.txt';
const TMP_PATH = path.join(os.homedir(), 'Downloads', TMP_NAME);

const PDF_NAME = 'gmail-mcp-test-data.bin';
const PDF_PATH = path.join(os.homedir(), 'Downloads', PDF_NAME);

const LINK_PATH = path.join(os.homedir(), 'Downloads', 'gmail-mcp-test-link.txt');

afterEach(() => {
	// lstat, not existsSync: a symlink to a missing target reports as absent.
	for (const p of [TMP_PATH, PDF_PATH, LINK_PATH]) {
		try {
			fs.lstatSync(p);
			fs.unlinkSync(p);
		} catch {
			// not there, nothing to clean up
		}
	}
});

describe('resolveAttachment', () => {
	it('reads a file from ~/Downloads and infers MIME type by extension', () => {
		fs.writeFileSync(TMP_PATH, 'hello');
		const result = resolveAttachment({path: TMP_PATH});
		expect(result.filename).toBe(TMP_NAME);
		expect(result.mimeType).toBe('text/plain');
		expect(Buffer.from(result.content, 'base64').toString()).toBe('hello');
	});

	it('rejects an absolute path outside the allowlist', () => {
		expect(() => resolveAttachment({path: '/etc/passwd'})).toThrow(/not allowed/);
	});

	it('rejects a ~-rooted path outside the allowlist', () => {
		expect(() => resolveAttachment({path: '~/.ssh/id_rsa'})).toThrow(/not allowed/);
	});

	/**
	 * path.resolve() is purely lexical and does not follow symlinks, so a link
	 * dropped inside an allowed root used to pass this gate and have its target
	 * read and emailed. realpathSync is what actually confines us. Without this
	 * test a refactor back to path.resolve() would be silently green.
	 */
	it('rejects a symlink inside an allowed root that points outside it', () => {
		fs.symlinkSync('/etc/hosts', LINK_PATH);
		expect(() => resolveAttachment({path: LINK_PATH})).toThrow(/not allowed/);
	});

	it('still follows a symlink whose target is inside an allowed root', () => {
		fs.writeFileSync(TMP_PATH, 'hello');
		fs.symlinkSync(TMP_PATH, LINK_PATH);
		expect(resolveAttachment({path: LINK_PATH}).content).toBe(Buffer.from('hello').toString('base64'));
	});

	// Removed from the allowlist 2026-08-02: the caller reads untrusted inbound
	// email, and neither source nor private notes are legitimately emailed.
	it('rejects the roots removed from the allowlist', () => {
		expect(() => resolveAttachment({path: '~/claude-memory/user_profile.md'})).toThrow(/not allowed/);
		expect(() => resolveAttachment({path: '~/code/gmail-mcp/package.json'})).toThrow(/not allowed/);
	});

	it('honors filename and mimeType overrides', () => {
		fs.writeFileSync(PDF_PATH, 'x');
		const result = resolveAttachment({
			path: PDF_PATH,
			filename: 'report.pdf',
			mimeType: 'application/pdf',
		});
		expect(result.filename).toBe('report.pdf');
		expect(result.mimeType).toBe('application/pdf');
	});

	it('passes base64 content through unchanged (no extra wrapping)', () => {
		const result = resolveAttachment({
			filename: 'x.txt',
			mimeType: 'text/plain',
			content: 'aGVsbG8=',
		});
		expect(result.content).toBe('aGVsbG8=');
	});

	it('strips embedded newlines from pre-wrapped base64 input', () => {
		const wrapped = 'aGVsbG8\r\n=';
		const result = resolveAttachment({
			filename: 'x.txt',
			mimeType: 'text/plain',
			content: wrapped,
		});
		expect(result.content).toBe('aGVsbG8=');
	});

	it('falls back to application/octet-stream for unknown extensions', () => {
		const oddPath = path.join(os.homedir(), 'Downloads', 'whatever.zzzunknown');
		fs.writeFileSync(oddPath, 'x');
		try {
			const result = resolveAttachment({path: oddPath});
			expect(result.mimeType).toBe('application/octet-stream');
		} finally {
			fs.unlinkSync(oddPath);
		}
	});
});

describe('appendMimeBody', () => {
	it('produces a single-part text body when no attachments', () => {
		const lines: string[] = [];
		appendMimeBody(lines, 'just text');
		const joined = lines.join('\r\n');
		expect(joined).toContain('Content-Type: text/plain; charset=utf-8');
		expect(joined).toContain('just text');
		expect(joined).not.toContain('multipart');
	});

	it('honors isHtml=true on single-part bodies', () => {
		const lines: string[] = [];
		appendMimeBody(lines, '<p>hi</p>', undefined, true);
		expect(lines.join('\r\n')).toContain('Content-Type: text/html; charset=utf-8');
	});

	it('produces multipart/mixed when attachments are present', () => {
		const lines: string[] = [];
		appendMimeBody(lines, 'body', [{filename: 'a.pdf', mimeType: 'application/pdf', content: 'AAAA'}]);
		const joined = lines.join('\r\n');
		expect(joined).toContain('MIME-Version: 1.0');
		expect(joined).toContain('multipart/mixed; boundary="');
		expect(joined).toContain('Content-Disposition: attachment; filename="a.pdf"');
		expect(joined).toContain('Content-Transfer-Encoding: base64');
	});

	it('uses text/html for the body part when isHtml=true with attachments', () => {
		const lines: string[] = [];
		appendMimeBody(lines, '<p>hi</p>', [{filename: 'a.pdf', mimeType: 'application/pdf', content: 'AAAA'}], true);
		const joined = lines.join('\r\n');
		expect(joined).toContain('multipart/mixed');
		expect(joined).toMatch(/Content-Type: text\/html; charset=utf-8/);
	});

	it('wraps base64 content at 76 characters per RFC 2045', () => {
		const longB64 = 'A'.repeat(200);
		const lines: string[] = [];
		appendMimeBody(lines, 'body', [{filename: 'a.bin', mimeType: 'application/octet-stream', content: longB64}]);
		const joined = lines.join('\r\n');
		const segment = joined.split('Content-Disposition: attachment; filename="a.bin"\r\n\r\n')[1] ?? '';
		const b64Lines = segment.split('\r\n').filter((l) => /^A+$/.exec(l));
		expect(b64Lines.length).toBeGreaterThan(1);
		for (const l of b64Lines) {
			expect(l.length).toBeLessThanOrEqual(76);
		}
	});
});
