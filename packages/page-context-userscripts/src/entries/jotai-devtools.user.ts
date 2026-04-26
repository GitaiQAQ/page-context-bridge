import { autoRegisterUserscriptAdapter } from '../hub';
import { createJotaiUserscriptAdapter } from '../adapters/jotai-adapter';

autoRegisterUserscriptAdapter(createJotaiUserscriptAdapter);
