import { autoRegisterUserscriptAdapter } from "../hub";
import { createTanstackQueryUserscriptAdapter } from "../adapters/tanstack-query-adapter";

autoRegisterUserscriptAdapter(createTanstackQueryUserscriptAdapter);
