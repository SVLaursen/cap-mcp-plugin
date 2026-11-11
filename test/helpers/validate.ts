import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { JsonSchema } from "../../src/types";

const validator = new AjvJsonSchemaValidator();

/**
 * Validate a value with the MCP SDK's own validator (ajv 2020-12, formats on), the one that
 * checks tool inputs and structuredContent at runtime. Returns the error message, or undefined.
 */
export function schemaError(schema: JsonSchema, value: unknown): string | undefined {
  const result = validator.getValidator(schema)(value);
  return result.valid ? undefined : (result.errorMessage ?? "invalid");
}
