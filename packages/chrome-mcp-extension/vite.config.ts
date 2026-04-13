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
  plugins: [chromeExtension() as any, copyStaticFiles(), renameUnderscoreFiles()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        manifest: resolve(__dirname, 'manifest.json'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        example: resolve(__dirname, 'example.html'),
      },
      output: {
        chunkFileNames: 'chunk-[name]-[hash].js',
        entryFileNames: '[name].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
