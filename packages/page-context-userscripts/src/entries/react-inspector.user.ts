import { autoRegisterUserscriptAdapter } from '../hub';
import { createReactUserscriptAdapter } from '../adapters/react-adapter';

autoRegisterUserscriptAdapter(createReactUserscriptAdapter);
