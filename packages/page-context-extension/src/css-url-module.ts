/**
 * 为 Vite 的 `?url` 资源导入补充 TypeScript 类型声明。
 */
declare module "*.css?url" {
  const url: string;
  export default url;
}
