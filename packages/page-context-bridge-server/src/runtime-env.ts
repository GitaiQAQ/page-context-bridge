/**
 * Unified reading of Node runtime environment variables.
 * Cannot directly write process.env, otherwise bundler may statically replace it with an empty object during build.
 */
export function getRuntimeEnv(): NodeJS.ProcessEnv {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: {
      env?: NodeJS.ProcessEnv;
    };
  };

  return globalWithProcess.process?.env ?? {};
}
