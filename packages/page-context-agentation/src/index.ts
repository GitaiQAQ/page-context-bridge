/**
 * @page-context/agentation — Public API
 *
 * Extracted agentation injection infrastructure from extension core.
 * Provides MAIN world bridge host installer, React fiber metadata detection,
 * and agentation main-world entry point factory.
 *
 * Layered architecture:
 *   main-world/  — Bridge host installer + agentation tab injection
 *   react-meta/    — React fiber detection + metadata enrichment
 *
 * NOTE: The Agentation React UI component (@page-context/extension/vendor/agentation)
 *       is NOT included here — it remains in the extension as a build-time dependency.
 */

// ─── Main World Injection ─────────────────────────────────────────────

export {
  ensureAgentationMainOnTab,
  ensureAgentationMainOnSenderTab,
  ensureMainWorldBridgeHostOnTab,
  ensureMainWorldBridgeHostOnSenderTab,
  getMainWorldInjectionTarget,
  type MainWorldBridgeHostInstaller,
  type MainWorldInjectionTarget,
} from './main-world/injection';

// ─── React Meta Detection ──────────────────────────────────────────────────

export { enrichUiAnchorReactMetaInMainWorld } from './react-meta';
