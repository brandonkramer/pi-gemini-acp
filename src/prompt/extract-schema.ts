import type { StructuredError } from "../types.js";

const SUPPORTED_TYPES = new Set([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);
const SUPPORTED_SCHEMA_KEYS = new Set([
	"type",
	"properties",
	"required",
	"items",
	"additionalProperties",
	"enum",
	"title",
	"description",
]);

/** Validates the deterministic JSON-schema-like subset accepted by gemini_extract. */
export function validateExtractionSchema(
	schema: unknown,
	path = "schema",
	seen = new WeakSet<object>(),
): StructuredError | undefined {
	const record = asRecord(schema);
	if (!record) return schemaError(`${path} must be a JSON object schema.`);
	if (seen.has(record)) {
		return schemaError(`${path} must not contain circular references.`);
	}
	seen.add(record);
	for (const key of Object.keys(record)) {
		if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
			return schemaError(
				`${path}.${key} is not supported. Supported keywords: type, properties, required, items, additionalProperties, enum, title, description.`,
			);
		}
	}
	const type = record.type;
	if (
		type !== undefined &&
		(typeof type !== "string" || !SUPPORTED_TYPES.has(type))
	) {
		return schemaError(
			`${path}.type must be one of object, array, string, number, integer, boolean, or null.`,
		);
	}
	if (record.enum !== undefined && !Array.isArray(record.enum)) {
		return schemaError(`${path}.enum must be an array when provided.`);
	}
	const propertiesError = validateProperties(record, type, path, seen);
	if (propertiesError) return propertiesError;
	const requiredError = validateRequired(record, path);
	if (requiredError) return requiredError;
	if (
		record.additionalProperties !== undefined &&
		typeof record.additionalProperties !== "boolean"
	) {
		return schemaError(
			`${path}.additionalProperties must be a boolean when provided.`,
		);
	}
	if (record.items !== undefined) {
		if (type !== "array") {
			return schemaError(`${path}.items is only supported on array schemas.`);
		}
		return validateExtractionSchema(record.items, `${path}.items`, seen);
	}
	return undefined;
}

/** Validates parsed Gemini JSON against the supported extraction schema subset. */
export function validateValueAgainstSchema(
	value: unknown,
	schema: unknown,
	path = "$.",
): string | undefined {
	const record = asRecord(schema);
	if (!record) return `${path} schema is invalid.`;
	if (
		Array.isArray(record.enum) &&
		!record.enum.some((entry) => Object.is(entry, value))
	) {
		return `${path} must equal one of the schema enum values.`;
	}
	const type =
		typeof record.type === "string" ? record.type : inferSchemaType(record);
	if (type && !matchesType(value, type)) return `${path} must be ${type}.`;
	if (type === "object") return validateObject(value, record, path);
	if (type === "array") return validateArray(value, record, path);
	return undefined;
}

function validateProperties(
	record: Record<string, unknown>,
	type: unknown,
	path: string,
	seen: WeakSet<object>,
): StructuredError | undefined {
	const properties = record.properties;
	if (properties === undefined) return undefined;
	const propertyRecord = asRecord(properties);
	if (!propertyRecord || (type !== undefined && type !== "object")) {
		return schemaError(
			`${path}.properties is only supported on object schemas.`,
		);
	}
	for (const [key, value] of Object.entries(propertyRecord)) {
		const child = validateExtractionSchema(
			value,
			`${path}.properties.${key}`,
			seen,
		);
		if (child) return child;
	}
	return undefined;
}

function validateRequired(
	record: Record<string, unknown>,
	path: string,
): StructuredError | undefined {
	if (record.required === undefined) return undefined;
	if (!Array.isArray(record.required) || !record.required.every(isString)) {
		return schemaError(`${path}.required must be an array of property names.`);
	}
	const propertyRecord = asRecord(record.properties) ?? {};
	for (const key of record.required) {
		if (!(key in propertyRecord)) {
			return schemaError(
				`${path}.required includes ${key}, but that property is not defined.`,
			);
		}
	}
	return undefined;
}

function validateObject(
	value: unknown,
	schema: Record<string, unknown>,
	path: string,
): string | undefined {
	const objectValue = asRecord(value);
	if (!objectValue) return `${path} must be object.`;
	const properties = asRecord(schema.properties) ?? {};
	const required = Array.isArray(schema.required)
		? schema.required.filter(isString)
		: [];
	for (const key of required) {
		if (!(key in objectValue)) return `${path}${key} is required.`;
	}
	for (const [key, childSchema] of Object.entries(properties)) {
		if (key in objectValue) {
			const child = validateValueAgainstSchema(
				objectValue[key],
				childSchema,
				`${path}${key}.`,
			);
			if (child) return child;
		}
	}
	if (schema.additionalProperties === false) {
		for (const key of Object.keys(objectValue)) {
			if (!(key in properties))
				return `${path}${key} is not allowed by the schema.`;
		}
	}
	return undefined;
}

function validateArray(
	value: unknown,
	schema: Record<string, unknown>,
	path: string,
): string | undefined {
	if (!Array.isArray(value)) return `${path} must be array.`;
	if (schema.items === undefined) return undefined;
	for (const [index, item] of value.entries()) {
		const child = validateValueAgainstSchema(
			item,
			schema.items,
			`${path}${index}.`,
		);
		if (child) return child;
	}
	return undefined;
}

function inferSchemaType(schema: Record<string, unknown>): string | undefined {
	if (schema.properties !== undefined) return "object";
	if (schema.items !== undefined) return "array";
	return undefined;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "object":
			return asRecord(value) !== undefined;
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			return true;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function schemaError(message: string): StructuredError {
	return {
		code: "GEMINI_EXTRACT_UNSUPPORTED_SCHEMA",
		phase: "schema_validation",
		message,
		retryable: false,
		provider: "gemini-acp",
	};
}
