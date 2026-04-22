import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { chromeExtension } from 'vite-plugin-chrome-extension';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

function copyStaticFiles() {
  return {
    name: 'copy-static-files',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');
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
      const distDir = resolve(__dirname, 'dist');
      const htmlFiles = readdirSync(distDir).filter((f) => f.endsWith('.html'));

      for (const htmlFile of htmlFiles) {
        const htmlPath = resolve(distDir, htmlFile);
        const cssFiles = readdirSync(distDir)
          .filter((f) => f.endsWith('.css'))
          .map((f) => `./${f}`);

        if (cssFiles.length === 0) continue;

        let html = readFileSync(htmlPath, 'utf8');
        const linkTags = cssFiles.map((css) => `  <link rel="stylesheet" href="${css}" />`).join('\n');
        html = html.replace('</head>', `${linkTags}\n</head>`);
        writeFileSync(htmlPath, html);
      }
    },
  };
}

function renameUnderscoreFiles() {
  return {
    name: 'rename-underscore-files',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');
      const files = readdirSync(distDir);

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
  plugins: [tailwindcss(), chromeExtension() as any, copyStaticFiles(), injectCssLinks(), renameUnderscoreFiles()],
  define: {
    // agentation 源码里用于版本展示的编译期常量，这里由 extension 构建侧提供。
    __VERSION__: JSON.stringify("3.0.2-src-poc"),
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        manifest: resolve(__dirname, 'manifest.json'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
      },
      output: {
        chunkFileNames: 'chunk-[name]-[hash].js',
        entryFileNames: '[name].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
