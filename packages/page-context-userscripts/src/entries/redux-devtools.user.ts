import { autoRegisterUserscriptAdapter } from '../hub';
import { createReduxDevtoolsUserscriptAdapter } from '../adapters/redux-devtools-adapter';

autoRegisterUserscriptAdapter(createReduxDevtoolsUserscriptAdapter);
