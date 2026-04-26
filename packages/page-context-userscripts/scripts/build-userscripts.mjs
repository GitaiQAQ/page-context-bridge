import { spawnSync } from 'node:child_process';

const entries = [
  'react-inspector',
  'apollo-client',
  'tanstack-query',
  'jotai-devtools',
  'redux-devtools',
  'nextjs',
  'nuxt',
];

for (const entry of entries) {
  const result = spawnSync('pnpm', ['run', 'build:one', '--mode', entry], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
