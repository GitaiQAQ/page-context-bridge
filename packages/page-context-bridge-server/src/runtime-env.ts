/**
 * 统一读取 Node 运行时环境变量。
 * 不能直接写 process.env，否则 bundler 可能在构建时把它静态替换成空对象。
 */
export function getRuntimeEnv(): NodeJS.ProcessEnv {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: {
      env?: NodeJS.ProcessEnv;
    };
  };

  return globalWithProcess.process?.env ?? {};
}
