import { z, type ZodRawShape, type ZodTypeAny } from "zod";

type PrimitiveLiteral = string | number | boolean | null | undefined | bigint;

export interface JsonSchemaLike {
  $ref?: string;
  $defs?: Record<string, JsonSchemaLike>;
  definitions?: Record<string, JsonSchemaLike>;
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike | JsonSchemaLike[];
  additionalProperties?: boolean | JsonSchemaLike;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  nullable?: boolean;
  oneOf?: JsonSchemaLike[];
  anyOf?: JsonSchemaLike[];
  allOf?: JsonSchemaLike[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

interface SchemaContext {
  root: JsonSchemaLike;
  refCache: Map<string, ZodTypeAny>;
}

export function buildZodSchema(inputSchema?: JsonSchemaLike): ZodRawShape {
  if (!inputSchema) {
    return {};
  }

  const normalizedRoot = normalizeObjectRoot(inputSchema);
  const objectSchema = toZodSchema(normalizedRoot, createSchemaContext(normalizedRoot));
  if (objectSchema instanceof z.ZodObject) {
    return objectSchema.shape;
  }

  return {};
}

export function toZodSchema(schema?: JsonSchemaLike, context?: SchemaContext): ZodTypeAny {
  if (!schema) {
    return z.any();
  }

  const resolvedContext = context ?? createSchemaContext(normalizeObjectRoot(schema));

  if (schema.$ref) {
    return createRefSchema(schema, resolvedContext);
  }

  if (schema.oneOf && schema.oneOf.length > 0) {
    return applyCommonModifiers(createUnionSchema(schema.oneOf.map((entry) => toZodSchema(entry, resolvedContext))), schema);
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    return applyCommonModifiers(createUnionSchema(schema.anyOf.map((entry) => toZodSchema(entry, resolvedContext))), schema);
  }

  if (schema.allOf && schema.allOf.length > 0) {
    const [first, ...rest] = schema.allOf;
    let merged = toZodSchema(first, resolvedContext);
    for (const entry of rest) {
      const next = toZodSchema(entry, resolvedContext);
      if (merged instanceof z.ZodObject && next instanceof z.ZodObject) {
        merged = merged.extend(next.shape);
      }
    }
    return applyCommonModifiers(merged, schema);
  }

  if (schema.const !== undefined) {
    return applyCommonModifiers(createConstSchema(schema.const), schema);
  }

  if (schema.enum && schema.enum.length > 0) {
    return applyCommonModifiers(createEnumSchema(schema.enum), schema);
  }

  const normalizedTypes = normalizeTypes(schema);
  const nonNullTypes = normalizedTypes.filter((type) => type !== "null");
  const nullable = schema.nullable === true || normalizedTypes.includes("null");

  let baseSchema: ZodTypeAny;
  if (nonNullTypes.length > 1) {
    baseSchema = createUnionSchema(nonNullTypes.map((type) => createPrimitiveSchema(type, schema, resolvedContext)));
  } else {
    baseSchema = createPrimitiveSchema(nonNullTypes[0], schema, resolvedContext);
  }

  if (nullable) {
    baseSchema = baseSchema.nullable();
  }

  return applyCommonModifiers(baseSchema, schema);
}

function normalizeObjectRoot(schema: JsonSchemaLike): JsonSchemaLike {
  if (schema.type === undefined && schema.properties) {
    return {
      type: "object",
      ...schema,
    };
  }
  return schema;
}

function normalizeTypes(schema: JsonSchemaLike): string[] {
  if (Array.isArray(schema.type) && schema.type.length > 0) {
    return schema.type;
  }
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  if (schema.properties) {
    return ["object"];
  }
  if (schema.items) {
    return ["array"];
  }
  return ["string"];
}

function createPrimitiveSchema(type: string | undefined, schema: JsonSchemaLike, context: SchemaContext): ZodTypeAny {
  switch (type) {
    case "number": {
      let numberSchema = z.number();
      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum);
      }
      return numberSchema;
    }
    case "integer": {
      let integerSchema = z.number().int();
      if (schema.minimum !== undefined) {
        integerSchema = integerSchema.min(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        integerSchema = integerSchema.max(schema.maximum);
      }
      return integerSchema;
    }
    case "boolean":
      return z.boolean();
    case "array":
      return createArraySchema(schema, context);
    case "object":
      return createObjectSchema(schema, context);
    case "null":
      return z.null();
    case "string":
    default:
      return createStringSchema(schema);
  }
}

function createStringSchema(schema: JsonSchemaLike): ZodTypeAny {
  let stringSchema = z.string();
  if (schema.minLength !== undefined) {
    stringSchema = stringSchema.min(schema.minLength);
  }
  if (schema.maxLength !== undefined) {
    stringSchema = stringSchema.max(schema.maxLength);
  }
  if (schema.pattern) {
    stringSchema = stringSchema.regex(new RegExp(schema.pattern));
  }
  return stringSchema;
}

function createArraySchema(schema: JsonSchemaLike, context: SchemaContext): ZodTypeAny {
  if (Array.isArray(schema.items) && schema.items.length > 0) {
    return z.tuple(schema.items.map((item) => toZodSchema(item, context)) as [ZodTypeAny, ...ZodTypeAny[]]);
  }
  return z.array(toZodSchema(Array.isArray(schema.items) ? schema.items[0] : schema.items, context));
}

function createObjectSchema(schema: JsonSchemaLike, context: SchemaContext): ZodTypeAny {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    let field = toZodSchema(property, context);
    if (!required.has(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }

  let objectSchema = z.object(shape);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    objectSchema = objectSchema.catchall(toZodSchema(schema.additionalProperties, context));
  } else if (schema.additionalProperties === true) {
    objectSchema = objectSchema.catchall(z.any());
  } else if (schema.additionalProperties === false) {
    objectSchema = objectSchema.strict();
  }

  return objectSchema;
}

function createRefSchema(schema: JsonSchemaLike, context: SchemaContext): ZodTypeAny {
  const ref = schema.$ref;
  if (!ref) {
    return z.any();
  }

  const base = resolveRefSchema(ref, context);
  const siblingSchema = stripRefKeywords(schema);
  if (!hasSchemaContent(siblingSchema)) {
    return base;
  }

  return toZodSchema({
    allOf: [
      { $ref: ref },
      siblingSchema,
    ],
  }, context);
}

function resolveRefSchema(ref: string, context: SchemaContext): ZodTypeAny {
  const cached = context.refCache.get(ref);
  if (cached) {
    return cached;
  }

  if (!ref.startsWith("#")) {
    throw new Error(`Unsupported external $ref: ${ref}`);
  }

  let resolvedSchema: ZodTypeAny = z.any();
  const lazySchema = z.lazy(() => resolvedSchema);
  context.refCache.set(ref, lazySchema);

  const target = resolveJsonPointer(context.root, ref);
  if (!isPlainObject(target)) {
    throw new Error(`Unable to resolve $ref target: ${ref}`);
  }

  resolvedSchema = toZodSchema(target as JsonSchemaLike, context);
  return lazySchema;
}

function resolveJsonPointer(root: JsonSchemaLike, ref: string): unknown {
  if (ref === "#") {
    return root;
  }

  const segments = ref
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function stripRefKeywords(schema: JsonSchemaLike): JsonSchemaLike {
  const { $ref: _ref, ...rest } = schema;
  return rest;
}

function hasSchemaContent(schema: JsonSchemaLike): boolean {
  return Object.entries(schema).some(([, value]) => value !== undefined);
}

function createEnumSchema(values: unknown[]): ZodTypeAny {
  const uniqueValues = [...new Set(values)];
  const literals = uniqueValues.map((value) => createConstSchema(value));
  return createUnionSchema(literals);
}

function createConstSchema(value: unknown): ZodTypeAny {
  if (isPrimitiveLiteral(value)) {
    return z.literal(value);
  }

  return z.custom<unknown>((candidate) => deepEqual(candidate, value), {
    message: `Expected exact constant value ${JSON.stringify(value)}`,
  });
}

function createUnionSchema(options: ZodTypeAny[]): ZodTypeAny {
  if (options.length === 0) {
    return z.any();
  }
  if (options.length === 1) {
    return options[0]!;
  }
  return z.union(options as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function applyCommonModifiers(schema: ZodTypeAny, jsonSchema: JsonSchemaLike): ZodTypeAny {
  let next = schema;
  if (jsonSchema.description) {
    next = next.describe(jsonSchema.description);
  }
  if (jsonSchema.default !== undefined) {
    next = next.default(jsonSchema.default);
  }
  return next;
}

function createSchemaContext(root: JsonSchemaLike): SchemaContext {
  return {
    root,
    refCache: new Map(),
  };
}

function isPrimitiveLiteral(value: unknown): value is PrimitiveLiteral {
  return value === null || ["string", "number", "boolean", "undefined", "bigint"].includes(typeof value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (typeof left !== typeof right) {
    return false;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => deepEqual(value, right[index]));
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
