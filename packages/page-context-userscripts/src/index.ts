export {
  autoRegisterUserscriptAdapter,
  getOrCreateUserscriptBridgeHub,
  type BrowserHost,
  type UserscriptBridgeHub,
} from "./hub";
export {
  PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT,
  getOrCreatePageContextBridgeHost,
} from "./bridge-host";
export {
  type PageContextBridgeHost,
  type PageContextBridgeHostSource,
  type PageContextBridgeLike,
  type PageToolInstance,
  type PageToolNamespace,
  type ToolInput,
  type UserscriptBridgeAdapter,
  type UserscriptBridgeAdapterFactory,
} from "./types";
export { createReactUserscriptAdapter } from "./adapters/react-adapter";
export { createApolloUserscriptAdapter } from "./adapters/apollo-adapter";
export { createTanstackQueryUserscriptAdapter } from "./adapters/tanstack-query-adapter";
export { createJotaiUserscriptAdapter } from "./adapters/jotai-adapter";
export { createReduxDevtoolsUserscriptAdapter } from "./adapters/redux-devtools-adapter";
