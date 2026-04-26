/**
 * Runtime validation schemas for RPC method parameters.
 *
 * These schemas replace unsafe `as` type assertions with Zod-based
 * runtime validation. Each schema corresponds to a BRIDGE_METHOD handler.
 *
 * For complex nested types (PageToolSpec[], etc.), we validate the structural
 * shape of scalar fields and keep arrays/objects as `unknown` for downstream
 * type narrowing — this avoids duplicating the full type definitions here.
 */
import { z } from 'zod';

// --- Bridge Server RPC handlers (extension -> bridge) ---

export const sessionRegisterParamsSchema = z.object({
  extensionId: z.string().optional(),
  version: z.string().optional(),
});

export const bridgePageEventParamsSchema = z.object({
  tabId: z.number().optional(),
  payload: z.unknown().optional(),
});

export const bridgePageToolsRegisteredParamsSchema = z.object({
  tabId: z.number().optional(),
  tools: z.array(z.any()).optional(),
});

export const bridgeBuiltinToolsUpdatedParamsSchema = z.object({
  tools: z.array(z.any()).optional(),
});

export const bridgePageToolsUnregisteredParamsSchema = z.object({
  tabId: z.number().optional(),
});

export const bridgeTabActivatedParamsSchema = z.object({
  tabId: z.number().optional(),
});

export const bridgeTabUpdatedParamsSchema = z.object({
  tabId: z.number().optional(),
});

// --- Extension RPC handlers (popup/sidepanel -> background) ---

export const extensionPageToolsGetParamsSchema = z.object({
  tabId: z.number().optional(),
});

export const extensionPageToolsDiscoverParamsSchema = z.object({
  tabId: z.number().optional(),
});

export const extensionContextManifestGetParamsSchema = z.object({
  tabId: z.number().optional(),
});

export const extensionContextResourceReadParamsSchema = z.object({
  tabId: z.number().optional(),
  resourceId: z.string().optional(),
});

export const extensionContextSkillGetParamsSchema = z.object({
  tabId: z.number().optional(),
  skillId: z.string().optional(),
  input: z.any().optional(),
});

export const extensionPageEventParamsSchema = z.object({
  payload: z.unknown().optional(),
});

export const extensionPageToolsRegisterParamsSchema = z.object({
  namespace: z.string().optional(),
  instanceId: z.string().optional(),
  tools: z.array(z.any()).optional(),
});

export const extensionPageToolsSetEnabledParamsSchema = z.object({
  root: z.enum(['builtin', 'page']).optional(),
  tabId: z.number().optional(),
  namespace: z.string().optional(),
  instanceId: z.string().optional(),
  toolName: z.string().optional(),
  enabled: z.boolean(),
});

export const extensionToolDebugCallParamsSchema = z.object({
  toolName: z.string().optional(),
  args: z.any().optional(),
  tabId: z.number().optional(),
});

export const bridgeToolCallParamsSchema = z.object({
  tool: z.string(),
  args: z.any().optional(),
  tabId: z.number().optional(),
});

const feedbackActorSchema = z.object({
  source: z.enum(['user', 'agent', 'bridge', 'extension']),
  id: z.string().min(1),
  displayName: z.string().min(1),
});

// uiAnchor structure only imposes necessary constraints: ensures basic type correctness, detailed cleaning still handled by store layer.
const feedbackUiRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const feedbackUiTextRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((value) => value.end >= value.start, {
    path: ['end'],
    message: 'end must be greater than or equal to start',
  });

const feedbackUiAnchorSchema = z.object({
  elementId: z.string().optional(),
  cssSelector: z.string().optional(),
  xpath: z.string().optional(),
  textQuote: z.string().optional(),
  framePath: z.array(z.number().int().nonnegative()).optional(),
  rect: feedbackUiRectSchema.optional(),
  textRange: feedbackUiTextRangeSchema.optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const feedbackStateSnapshotParamsSchema = z.object({
  tabId: z.number().int().optional(),
  sessionId: z.string().optional(),
});

export const feedbackStateDeltaParamsSchema = z.object({
  afterSeq: z.number().int().nonnegative().default(0),
  sessionId: z.string().optional(),
});

export const feedbackAnnotationCreateParamsSchema = z.object({
  body: z.string().trim().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  tabId: z.number().int(),
  url: z.string().min(1),
  title: z.string().optional(),
  selectedText: z.string().optional(),
  uiAnchor: feedbackUiAnchorSchema.optional(),
  actor: feedbackActorSchema.optional(),
});

export const feedbackAnnotationUpdateParamsSchema = z.object({
  annotationId: z.string().min(1),
  body: z.string().trim().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  actor: feedbackActorSchema.optional(),
});

export const feedbackAnnotationClaimParamsSchema = z.object({
  annotationId: z.string().min(1),
  actor: feedbackActorSchema.optional(),
});

export const feedbackAnnotationReplyParamsSchema = z.object({
  annotationId: z.string().min(1),
  body: z.string().trim().min(1),
  kind: z.enum(['comment', 'action_note', 'resolution_note']).optional(),
  actor: feedbackActorSchema.optional(),
});

export const feedbackAnnotationResolveParamsSchema = z.object({
  annotationId: z.string().min(1),
  resolution: z.string().optional(),
  actor: feedbackActorSchema.optional(),
});

export const feedbackAnnotationDismissParamsSchema = z.object({
  annotationId: z.string().min(1),
  dismissReason: z.string().optional(),
  actor: feedbackActorSchema.optional(),
});

/**
 * Validate params against a Zod schema, returning the parsed result
 * or throwing an Error with descriptive validation issues.
 */
export function validateParams<T>(schema: z.ZodType<T>, params: unknown, methodName: string): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid params for ${methodName}: ${issues}`);
  }
  return result.data;
}
