import { autoRegisterUserscriptAdapter } from '../hub';
import { createNextjsUserscriptAdapter } from '../adapters/nextjs-adapter';

autoRegisterUserscriptAdapter(createNextjsUserscriptAdapter);
