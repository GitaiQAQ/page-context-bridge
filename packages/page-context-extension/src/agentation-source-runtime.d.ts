import type { ComponentType } from 'react';

export interface Annotation {
  id: string;
  x: number;
  y: number;
  comment: string;
  element: string;
  elementPath: string;
  timestamp: number;
  selectedText?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  fullPath?: string;
  reactComponents?: string;
  sourceFile?: string;
  isMultiSelect?: boolean;
  isFixed?: boolean;
  severity?: 'blocking' | 'important' | 'suggestion';
}

export interface AgentationProps {
  onAnnotationAdd?: (annotation: Annotation) => void;
  onAnnotationDelete?: (annotation: Annotation) => void;
  onAnnotationUpdate?: (annotation: Annotation) => void;
  onSubmit?: (output: string, annotations: Annotation[]) => void;
  onCopy?: (markdown: string) => void;
  copyToClipboard?: boolean;
  className?: string;
}

export const Agentation: ComponentType<AgentationProps>;
