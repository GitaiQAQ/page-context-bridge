import type {
  ContextResourcePayload,
  ContextSkillDescriptor,
  ContextSkillPrompt,
  ToolSpec,
} from "@page-context/shared-protocol";

import type { ToolInput } from "./types";

export const READONLY_ANNOTATION = { readOnlyHint: true };

export function toJsonResource(id: string, data: unknown): ContextResourcePayload {
  return {
    id,
    mimeType: "application/json",
    text: safeStringify(data),
  };
}

export function buildSkillPrompt(
  skill: ContextSkillDescriptor,
  context: {
    goal: string;
    focus: string;
    facts: string[];
  },
): ContextSkillPrompt {
  const lines = [
    `Skill: ${skill.title}`,
    `Goal: ${context.goal}`,
    `Focus: ${context.focus}`,
    `Facts: ${context.facts.join(" | ") || "(none)"}`,
    `Recommended resources: ${(skill.resourceIds ?? []).join(", ") || "(none)"}`,
    `Allowed tools: ${(skill.toolNames ?? []).join(", ") || "(none)"}`,
    "Checklist:",
    "1) Start with verifiable facts, then move to inference.",
    "2) Call out missing information and the next useful inspection step.",
    "3) Keep the conclusion read-only and avoid proposing page mutations.",
  ];
  return { skill, text: lines.join("\n") };
}

export function normalizeSkillInput(input: ToolInput): { goal: string; focus: string } {
  const goal = typeof input.goal === "string" && input.goal.trim() ? input.goal.trim() : "Inspect the current runtime issue and build an evidence chain.";
  const focus = typeof input.focus === "string" && input.focus.trim() ? input.focus.trim() : "stability and explainability";
  return { goal, focus };
}

export function listToolNames(namespace: string, instanceId: string, tools: ToolSpec[]): string[] {
  return tools.map((tool) => `${namespace}.${instanceId}.${tool.name}`);
}

export function previewValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function") {
    const namedFn = value as Function & { displayName?: string };
    return `[Function ${namedFn.displayName || namedFn.name || "anonymous"}]`;
  }
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (isObjectRecord(value)) {
    const keys = Object.keys(value);
    const keyPreview = keys.slice(0, 6).join(", ");
    return keys.length > 6 ? `{ ${keyPreview}, ... }` : `{ ${keyPreview} }`;
  }
  return Object.prototype.toString.call(value);
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ error: "Unable to stringify payload" }, null, 2);
  }
}

export function safeRoute(win: Window): string {
  try {
    const pathname = win.location?.pathname ?? "/";
    const search = win.location?.search ?? "";
    return `${pathname}${search}`;
  } catch {
    return "/";
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
