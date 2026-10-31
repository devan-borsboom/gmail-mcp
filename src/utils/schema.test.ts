import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {normalizeObjectSchema} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import {toJsonSchemaCompat} from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {strictSchemaWithAliases} from './schema.js';

/**
 * Under zod 4 the SDK only recognises a schema as an object schema when its
 * own definition is an object. The old zod 3 helper wrapped the object in a
 * preprocess step and patched `.shape` on the wrapper, which zod 4 ignores:
 * every tool then advertised an empty parameter list to the client.
 */
describe('strictSchemaWithAliases under zod 4', () => {
	const schema = strictSchemaWithAliases({
		to: z.string().describe('Recipient'),
		subject: z.string().optional(),
	});

	it('is recognised by the SDK as an object schema', () => {
		expect(normalizeObjectSchema(schema)).toBeDefined();
	});

	it('advertises its parameters to the client', () => {
		const json = toJsonSchemaCompat(normalizeObjectSchema(schema)!) as {properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown};
		expect(Object.keys(json.properties ?? {}).sort()).toEqual(['subject', 'to']);
		expect(json.required).toEqual(['to']);
		expect(json.additionalProperties).toBe(false);
	});

	it('still rejects unknown parameters', () => {
		expect(schema.safeParse({to: 'a@example.com', smuggled: 1}).success).toBe(false);
		expect(schema.safeParse({to: 'a@example.com'}).success).toBe(true);
	});

	it('refuses a non-empty alias map loudly instead of silently dropping the parameter list', () => {
		expect(() => strictSchemaWithAliases({new_str: z.string()}, {new_string: 'new_str'})).toThrow(/alias/i);
	});
});
