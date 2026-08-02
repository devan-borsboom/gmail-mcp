import {describe, it, expect} from 'vitest';
import {
	decodeEntities, normalizeMessageId, normalizeReferences, buildThreadHeaders, foldHeader,
} from './msgid.js';

const PARENT = '<CAMpzVZ==w4J50t9U3rH5xN1-gP2_nOoZrrRoto0S8g-WngHFXg@mail.gmail.com>';
const GRANDPARENT = '<CAG3MzU0NeBtJZeBh5S+1mut5uXK6176uQybvOHT6R-Zxya9t5w@mail.gmail.com>';

describe('decodeEntities', () => {
	it('decodes the escaped angle brackets that broke real sends', () => {
		expect(decodeEntities('&lt;abc@mail.gmail.com&gt;')).toBe('<abc@mail.gmail.com>');
	});

	it('decodes double-encoded input', () => {
		expect(decodeEntities('&amp;lt;abc@mail.gmail.com&amp;gt;')).toBe('<abc@mail.gmail.com>');
	});

	it('leaves clean input untouched', () => {
		expect(decodeEntities(PARENT)).toBe(PARENT);
	});
});

describe('normalizeMessageId', () => {
	it('repairs an HTML-escaped id', () => {
		const escaped = '&lt;CAMpzVZ==w4J50t9U3rH5xN1-gP2_nOoZrrRoto0S8g-WngHFXg@mail.gmail.com&gt;';
		expect(normalizeMessageId(escaped)).toBe(PARENT);
	});

	it('adds missing angle brackets', () => {
		expect(normalizeMessageId('abc@mail.gmail.com')).toBe('<abc@mail.gmail.com>');
	});

	it('trims surrounding whitespace', () => {
		expect(normalizeMessageId('  <abc@mail.gmail.com>\n')).toBe('<abc@mail.gmail.com>');
	});

	it('rejects an id with no domain part', () => {
		expect(normalizeMessageId('<not-a-message-id>')).toBeUndefined();
	});

	it('rejects header injection attempts', () => {
		expect(normalizeMessageId('<a@b.com>\r\nBcc: attacker@evil.com')).toBeUndefined();
	});

	it('rejects empty input', () => {
		expect(normalizeMessageId('   ')).toBeUndefined();
	});
});

describe('normalizeReferences', () => {
	it('parses a multi-id chain', () => {
		expect(normalizeReferences(`${GRANDPARENT} ${PARENT}`)).toEqual([GRANDPARENT, PARENT]);
	});

	it('parses an escaped chain', () => {
		const escaped = '&lt;a@x.com&gt; &lt;b@x.com&gt;';
		expect(normalizeReferences(escaped)).toEqual(['<a@x.com>', '<b@x.com>']);
	});

	it('de-duplicates while preserving order', () => {
		expect(normalizeReferences('<a@x.com> <b@x.com> <a@x.com>')).toEqual(['<a@x.com>', '<b@x.com>']);
	});

	it('returns an empty list for undefined', () => {
		expect(normalizeReferences(undefined)).toEqual([]);
	});
});

describe('buildThreadHeaders', () => {
	it('accumulates the parent onto the inherited chain', () => {
		const result = buildThreadHeaders(PARENT, GRANDPARENT);
		expect(result.inReplyTo).toBe(PARENT);
		expect(result.references).toBe(`${GRANDPARENT} ${PARENT}`);
	});

	it('does not duplicate a parent already present in the chain', () => {
		const result = buildThreadHeaders(PARENT, `${GRANDPARENT} ${PARENT}`);
		expect(result.references).toBe(`${GRANDPARENT} ${PARENT}`);
	});

	it('falls back to a single-element chain when references is omitted', () => {
		expect(buildThreadHeaders(PARENT)).toEqual({inReplyTo: PARENT, references: PARENT});
	});

	it('emits nothing for a non-reply', () => {
		expect(buildThreadHeaders(undefined, undefined)).toEqual({});
	});

	it('drops an unusable parent rather than emitting a malformed header', () => {
		expect(buildThreadHeaders('garbage', undefined)).toEqual({});
	});

	it('repairs escaped input end to end', () => {
		const result = buildThreadHeaders('&lt;b@x.com&gt;', '&lt;a@x.com&gt;');
		expect(result.inReplyTo).toBe('<b@x.com>');
		expect(result.references).toBe('<a@x.com> <b@x.com>');
	});
});

describe('foldHeader', () => {
	it('leaves a short header on one line', () => {
		expect(foldHeader('References', '<a@x.com>')).toBe('References: <a@x.com>');
	});

	it('folds a long chain with continuation lines starting in whitespace', () => {
		const chain = Array.from({length: 8}, (_, i) => `<message-number-${i}@mail.gmail.com>`).join(' ');
		const folded = foldHeader('References', chain);
		const lines = folded.split('\r\n');
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0].startsWith('References: ')).toBe(true);
		for (const line of lines.slice(1)) {
			expect(line.startsWith(' ')).toBe(true);
		}

		// Every id survives the fold.
		expect(folded.replace(/\r\n /g, ' ')).toBe(`References: ${chain}`);
	});
});
