import { describe, expect, it } from 'vitest';

import { buildZodSchema, toZodSchema } from './schema.js';

describe('buildZodSchema', () => {
  it('marks required and optional fields correctly', () => {
    const shape = buildZodSchema({
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        limit: { type: 'number', description: 'Max items' },
      },
      required: ['selector'],
    });

    expect(() => shape.selector.parse('#app')).not.toThrow();
    expect(() => shape.limit.parse(undefined)).not.toThrow();
  });

  it('supports enum values', () => {
    const shape = buildZodSchema({
      properties: {
        level: { enum: ['all', 'warn', 'error'] },
      },
    });

    expect(shape.level.parse('warn')).toBe('warn');
  });

  it('supports nested objects and arrays', () => {
    const shape = buildZodSchema({
      properties: {
        payload: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' },
                },
              },
            },
          },
        },
      },
      required: ['payload'],
    });

    expect(() =>
      shape.payload.parse({
        items: [{ id: 1, name: 'alpha' }],
      }),
    ).not.toThrow();
    expect(() => shape.payload.parse({ items: [{ id: 1.5 }] })).toThrow();
  });

  it('supports nullable union and defaults', () => {
    const schema = toZodSchema({
      type: ['string', 'null'],
      default: 'fallback',
    });

    expect(schema.parse(undefined)).toBe('fallback');
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse('ok')).toBe('ok');
  });

  it('supports additionalProperties typing and scalar constraints', () => {
    const schema = toZodSchema({
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, pattern: '^[a-z]+$' },
      },
      additionalProperties: { type: 'number', minimum: 1 },
    });

    expect(() => schema.parse({ query: 'abc', page: 2 })).not.toThrow();
    expect(() => schema.parse({ query: 'A', page: 0 })).toThrow();
  });

  it('supports mixed-type enums and oneOf', () => {
    const enumSchema = toZodSchema({ enum: ['all', 1, true] });
    expect(enumSchema.parse('all')).toBe('all');
    expect(enumSchema.parse(1)).toBe(1);
    expect(() => enumSchema.parse(false)).toThrow();

    const oneOfSchema = toZodSchema({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(oneOfSchema.parse('demo')).toBe('demo');
    expect(oneOfSchema.parse(42)).toBe(42);
  });

  it('supports local $defs references', () => {
    const schema = toZodSchema({
      type: 'object',
      required: ['filter'],
      properties: {
        filter: { $ref: '#/$defs/filter' },
      },
      $defs: {
        filter: {
          type: 'object',
          required: ['selector'],
          properties: {
            selector: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1 },
          },
        },
      },
    });

    expect(() => schema.parse({ filter: { selector: '.item', limit: 2 } })).not.toThrow();
    expect(() => schema.parse({ filter: { selector: '', limit: 0 } })).toThrow();
  });

  it('supports legacy definitions references', () => {
    const shape = buildZodSchema({
      type: 'object',
      required: ['payload'],
      properties: {
        payload: { $ref: '#/definitions/payload' },
      },
      definitions: {
        payload: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    });

    expect(() => shape.payload.parse({ id: 'abc' })).not.toThrow();
    expect(() => shape.payload.parse({})).toThrow();
  });

  it('supports recursive self references', () => {
    const schema = toZodSchema({
      $ref: '#/$defs/node',
      $defs: {
        node: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            children: {
              type: 'array',
              items: { $ref: '#/$defs/node' },
            },
          },
        },
      },
    });

    expect(() =>
      schema.parse({
        name: 'root',
        children: [{ name: 'leaf', children: [] }],
      }),
    ).not.toThrow();
    expect(() => schema.parse({ children: [] })).toThrow();
  });
});
