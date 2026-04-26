/**
 * Add TypeScript type declarations for Vite's `?url` resource imports.
 */
declare module '*.css?url' {
  const url: string;
  export default url;
}
