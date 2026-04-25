/**
 * Re-export shim — delegates to @page-context/tool-visibility.
 * New code should import directly from "@page-context/tool-visibility".
 */
export type { PageToolEntry, PageToolSpec } from "@page-context/tool-visibility";
export {
  flattenPageTools,
  mergePageToolEntry,
  normalizePageToolEntries,
} from "@page-context/tool-visibility";
