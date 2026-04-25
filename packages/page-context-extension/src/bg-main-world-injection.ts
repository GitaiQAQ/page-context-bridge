/**
 * Re-export shim — delegates to @page-context/agentation.
 * New code should import directly from "@page-context/agentation".
 */
export {
  ensureAgentationMainOnTab,
  ensureAgentationMainOnSenderTab,
  ensureMainWorldBridgeHostOnTab,
  ensureMainWorldBridgeHostOnSenderTab,
  getMainWorldInjectionTarget,
  type MainWorldBridgeHostInstaller,
  type MainWorldInjectionTarget,
} from "@page-context/agentation";
