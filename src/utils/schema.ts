import {z, type ZodRawShape} from 'zod';

type AliasMap = Record<string, string>;

/**
 * Creates a strict Zod object schema that rejects any unknown parameters.
 *
 * Under zod 3 this also accepted aliased parameter names by wrapping the
 * object in a preprocess step and patching `.shape` onto the wrapper so the
 * MCP SDK could still find the parameter list. Zod 4 turns preprocess into a
 * pipe, and the SDK only treats a schema as an object when its own definition
 * is an object, so that wrapper would make every tool advertise an empty
 * parameter list. No tool in this server uses an alias, so the schema is now
 * the plain strict object, and a non-empty alias map fails at startup rather
 * than silently shipping a tool the client cannot see the parameters of.
 */
export function strictSchemaWithAliases<T extends ZodRawShape>(
	shape: T,
	aliases: AliasMap = {},
) {
	if (Object.keys(aliases).length > 0) {
		throw new Error('strictSchemaWithAliases: parameter aliases are not supported under zod 4 (see utils/schema.ts)');
	}

	return z.object(shape).strict();
}
