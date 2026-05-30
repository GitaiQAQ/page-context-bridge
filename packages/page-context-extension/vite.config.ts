import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { chromeExtension } from 'vite-plugin-chrome-extension';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const extensionBuildTime = new Date().toISOString();
process.env.VITE_PAGE_CONTEXT_EXTENSION_BUILD_TIME = extensionBuildTime;
const extensionOutputDir = process.env.PAGE_CONTEXT_EXTENSION_OUT_DIR?.trim() || 'dist';
const extensionOutputAbsDir = resolve(__dirname, extensionOutputDir);

// Keep consistent with HOST_ID in src/agentation-main.tsx, used for CSS inline injection target
const AGENTATION_MAIN_HOST_ID = '__pc_agentation_main__';

function copyStaticFiles() {
  return {
    name: 'copy-static-files',
    closeBundle() {
      // The build directory is controlled by an env var.
      // Chromium / Firefox can write separate artifacts, avoiding parallel E2E collisions.
      const distDir = extensionOutputAbsDir;
      const files: Array<{ src: string; dest: string }> = [];

      for (const { src, dest } of files) {
        try {
          const content = readFileSync(resolve(__dirname, src), 'utf8');
          writeFileSync(resolve(distDir, dest), content);
        } catch (error) {
          console.warn(`Failed to copy ${src}:`, error);
        }
      }

      // Copy icons directory
      const iconsDir = resolve(__dirname, 'icons');
      const distIconsDir = resolve(distDir, 'icons');
      try {
        mkdirSync(distIconsDir, { recursive: true });
        const iconFiles = readdirSync(iconsDir);
        for (const file of iconFiles) {
          const content = readFileSync(resolve(iconsDir, file));
          writeFileSync(resolve(distIconsDir, file), content);
        }
      } catch (error) {
        console.warn('Failed to copy icons:', error);
      }
    },
  };
}

function injectCssLinks() {
  return {
    name: 'inject-css-links',
    closeBundle() {
      const distDir = extensionOutputAbsDir;
      const htmlFiles = readdirSync(distDir).filter((f) => f.endsWith('.html'));

      for (const htmlFile of htmlFiles) {
        const htmlPath = resolve(distDir, htmlFile);
        const cssFiles = readdirSync(distDir)
          .filter((f) => f.endsWith('.css'))
          .map((f) => `./${f}`);

        if (cssFiles.length === 0) continue;

        let html = readFileSync(htmlPath, 'utf8');
        const linkTags = cssFiles
          .map((css) => `  <link rel="stylesheet" href="${css}" />`)
          .join('\n');
        html = html.replace('</head>', `${linkTags}\n</head>`);
        writeFileSync(htmlPath, html);
      }
    },
  };
}

function patchSidepanelBuildTimeAttribute(distDir: string) {
  const sidepanelHtmlPath = resolve(distDir, 'sidepanel.html');

  try {
    const html = readFileSync(sidepanelHtmlPath, 'utf8');
    const patchedHtml = html
      .replaceAll('%VITE_PAGE_CONTEXT_EXTENSION_BUILD_TIME%', extensionBuildTime)
      .replaceAll('__PAGE_CONTEXT_EXTENSION_BUILD_TIME__', extensionBuildTime);

    if (patchedHtml === html) {
      // Both writeBundle and closeBundle reach this path.
      // If the first pass already patched it, the placeholder is gone; that is not an error.
      return;
    }

    writeFileSync(sidepanelHtmlPath, patchedHtml);
    console.log(`Patched side-panel build time html: ${extensionBuildTime}`);
  } catch (error) {
    console.warn('Failed to patch side-panel build time html:', error);
  }
}

function renameUnderscoreFiles() {
  return {
    name: 'rename-underscore-files',
    writeBundle() {
      const distDir = extensionOutputAbsDir;
      patchSidepanelBuildTimeAttribute(distDir);
    },
    closeBundle() {
      const distDir = extensionOutputAbsDir;
      const files = readdirSync(distDir);

      patchSidepanelBuildTimeAttribute(distDir);

      // Rename content-script.<hash>.css to a fixed name for easy dynamic injection by content-script.ts
      const cssFile = files.find((f) => /^content-script\.[a-zA-Z0-9]+\.css$/.test(f));
      if (cssFile) {
        const oldPath = resolve(distDir, cssFile);
        const newPath = resolve(distDir, 'content-script.css');
        if (oldPath !== newPath) {
          copyFileSync(oldPath, newPath);
          unlinkSync(oldPath);
          console.log(`Renamed ${cssFile} -> content-script.css`);

          // Add content-script.css to manifest's web_accessible_resources
          try {
            const manifestPath = resolve(distDir, 'manifest.json');
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            const war = manifest.web_accessible_resources;
            if (Array.isArray(war)) {
              for (const entry of war) {
                if (
                  Array.isArray(entry.resources) &&
                  !entry.resources.includes('content-script.css')
                ) {
                  entry.resources.push('content-script.css');
                }
              }
            }
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
          } catch (_) {
            console.warn('Failed to patch manifest.json for content-script.css');
          }
        }
      }

      // Move agentation-main entry JS to root directory and add to web_accessible_resources
      // chromeExtension plugin preserves src/ prefix, actual output is dist/src/agentation-main-entry.js
      // background injects via chrome.scripting.executeScript({ world: "MAIN", files: ["agentation-main.js"] })
      const allFiles = readdirSync(distDir);
      const mainEntryJs =
        allFiles.find((f) => f === 'agentation-main.js') ??
        (() => {
          // Search subdirectories (chromeExtension may preserve src/ path prefix)
          for (const dir of ['src']) {
            try {
              const subFiles = readdirSync(resolve(distDir, dir));
              const found = subFiles.find((f) => /agentation-main/.test(f));
              if (found) return `${dir}/${found}`;
            } catch {
              /* directory does not exist */
            }
          }
          return null;
        })();

      if (mainEntryJs) {
        const targetName = 'agentation-main.js';
        if (mainEntryJs !== targetName) {
          const oldPath = resolve(distDir, mainEntryJs);
          const newPath = resolve(distDir, targetName);
          try {
            copyFileSync(oldPath, newPath);
            console.log(`Copied ${mainEntryJs} -> ${targetName} for MAIN world injection`);
          } catch (error) {
            console.warn(`Failed to copy ${mainEntryJs}:`, error);
          }
        }

        // Inline agentation-main CSS into JS end (MAIN world has no chrome.runtime API, cannot dynamically load external CSS)
        // Vite extracted CSS filename matches the entry: agentation-main-entry.<hash>.css
        const cssFiles = readdirSync(distDir).filter((f) => /agentation-main.*\.css$/.test(f));
        for (const cssFile of cssFiles) {
          try {
            const cssPath = resolve(distDir, cssFile);
            const cssContent = readFileSync(cssPath, 'utf8');
            const jsPath = resolve(distDir, targetName);
            const jsContent = readFileSync(jsPath, 'utf8');
            // Inject CSS into page document (instead of Shadow DOM).
            // Reason: Agentation vendor internally uses createPortal(..., document.body), rendering nodes under page body.
            // <style> inside Shadow DOM cannot affect nodes portaled to body, so global injection is necessary.
            // Since CSS modules/hashed class names rarely conflict with page styles, this is acceptable.
            const fullCss = cssContent;
            const styleId = '__pc_agentation_main_css__';
            const inlineScript = `
;(function(){try{if(document.getElementById(${JSON.stringify(styleId)}))return;var s=document.createElement('style');s.id=${JSON.stringify(styleId)};s.textContent=${JSON.stringify(fullCss)};var p=document.head||document.documentElement;if(p)p.appendChild(s)}catch(e){console.warn('[AGENTATION-MAIN] inject css failed',e)}})();
`;
            writeFileSync(jsPath, jsContent + inlineScript);
            console.log(`Inlined ${cssFile} into ${targetName}`);
            unlinkSync(cssPath); // Delete standalone CSS file after inlining
          } catch (error) {
            console.warn(`Failed to inline ${cssFile}:`, error);
          }
        }

        try {
          const manifestPath = resolve(distDir, 'manifest.json');
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
          const war = manifest.web_accessible_resources;
          if (Array.isArray(war)) {
            for (const entry of war) {
              if (Array.isArray(entry.resources) && !entry.resources.includes(targetName)) {
                entry.resources.push(targetName);
              }
            }
          }
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        } catch (_) {
          console.warn('Failed to patch manifest.json for agentation-main.js');
        }
      } else {
        console.warn('agentation-main entry JS not found in build output');
      }

      for (const file of files) {
        if (file.startsWith('_')) {
          const oldPath = resolve(distDir, file);
          const newName = 'chunk' + file;
          const newPath = resolve(distDir, newName);

          try {
            const content = readFileSync(oldPath);
            writeFileSync(newPath, content);
            unlinkSync(oldPath);
            console.log(`Renamed ${file} -> ${newName}`);
          } catch (error) {
            console.warn(`Failed to rename ${file}:`, error);
          }
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    chromeExtension() as any,
    copyStaticFiles(),
    injectCssLinks(),
    renameUnderscoreFiles(),
  ],
  define: {
    // Compile-time constant for version display in agentation source code, provided here by extension build side.
    __VERSION__: JSON.stringify('3.0.2-src-poc'),
    // agentation toolbar uses process.env.NODE_ENV to determine whether to enable React component detection.
    // In extension scenarios, target pages may be dev or prod, but component detection capability should always be enabled.
    'process.env.NODE_ENV': JSON.stringify('development'),
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  build: {
    // For easier debugging and avoiding behavioral differences in artifacts: disable minify for entire project
    minify: false,
    cssMinify: false,
    // Allow callers to set the target directory explicitly.
    // Keep dist as the default for watch / dev-preview compatibility.
    outDir: extensionOutputDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        manifest: resolve(__dirname, 'manifest.json'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        // MAIN world Agentation entry: React + vendor all bundled as standalone JS
        'agentation-main': resolve(__dirname, 'src/agentation-main-entry.ts'),
      },
      output: {
        chunkFileNames: 'chunk-[name]-[hash].js',
        entryFileNames: '[name].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
