#!/usr/bin/env node
/**
 * Dev Preview Script
 * Builds the extension and opens it in Playwright with a sample page
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, rmSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const devProfileDir = path.join(projectRoot, '.tmp', 'dev-preview-profile');
const shouldResetProfile = process.argv.includes('--reset-profile');

if (shouldResetProfile) {
  rmSync(devProfileDir, { recursive: true, force: true });
}

mkdirSync(devProfileDir, { recursive: true });
cleanupChromiumSingletonArtifacts(devProfileDir);

console.log('Building extension...\n');
try {
  execSync('pnpm run build', { cwd: projectRoot, stdio: 'inherit' });
  console.log('\nBuild completed\n');
} catch (error) {
  console.error('\nBuild failed:', error.message);
  process.exit(1);
}

let chromium;
try {
  const playwright = await import('@playwright/test');
  chromium = playwright.chromium;
} catch (error) {
  console.error('Failed to import playwright:', error.message);
  console.log('Please ensure playwright is installed: pnpm add -D @playwright/test');
  process.exit(1);
}

const extensionPath = path.join(projectRoot, 'dist');

console.log('Launching browser with extension...\n');

const launchOptions = buildBrowserLaunchOptions(extensionPath);
console.log(`Browser target: ${launchOptions.browserLabel}\n`);

const context = await chromium.launchPersistentContext(devProfileDir, launchOptions.playwrightOptions);

await new Promise(resolve => setTimeout(resolve, 2000));

const workers = context.serviceWorkers();
const serviceWorker = workers.find(w => w.url().includes('background'));
let extensionId = null;

if (serviceWorker) {
  const match = serviceWorker.url().match(/chrome-extension:\/\/([a-p]{32})/);
  extensionId = match ? match[1] : null;
}

console.log('Opening test page...\n');
const page = await context.newPage();
await page.goto('about:blank');

if (extensionId) {
  console.log(`Extension ID: ${extensionId}`);
  console.log(`Extension popup: chrome-extension://${extensionId}/popup.html`);
}

console.log('Preview is ready!');
console.log('   - Extension is loaded in the browser');
console.log(`   - Dev profile: ${devProfileDir}`);
console.log('   - Pass --reset-profile if you want a clean extension storage state');
console.log('\nPress Ctrl+C to close the browser\n');

process.stdin.resume();

process.on('SIGINT', async () => {
  console.log('\nClosing browser...');
  await context.close();
  process.exit(0);
});

function buildBrowserLaunchOptions(extensionPath) {
  const baseArgs = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--window-size=1400,900'
  ];

  return {
    browserLabel: 'Playwright chromium channel',
    playwrightOptions: {
      headless: false,
      channel: 'chromium',
      args: baseArgs
    }
  };
}

function cleanupChromiumSingletonArtifacts(profileDir) {
  const transientArtifacts = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

  for (const artifact of transientArtifacts) {
    const artifactPath = path.join(profileDir, artifact);
    if (!existsSync(artifactPath)) {
      continue;
    }
    rmSync(artifactPath, { recursive: true, force: true });
  }
}
