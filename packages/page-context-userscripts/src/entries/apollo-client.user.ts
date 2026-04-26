import { autoRegisterUserscriptAdapter } from '../hub';
import { createApolloUserscriptAdapter } from '../adapters/apollo-adapter';

autoRegisterUserscriptAdapter(createApolloUserscriptAdapter);
