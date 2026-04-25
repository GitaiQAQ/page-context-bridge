import { autoRegisterUserscriptAdapter } from "../hub";
import { createNuxtUserscriptAdapter } from "../adapters/nuxt-adapter";

autoRegisterUserscriptAdapter(createNuxtUserscriptAdapter);

