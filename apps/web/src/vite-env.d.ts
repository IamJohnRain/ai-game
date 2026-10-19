// apps/web/src/vite-env.d.ts —— Vite 资源导入的类型声明（本项目只用到 ?raw 文本导入）
declare module "*.svg?raw" {
  const content: string;
  export default content;
}

declare module "*.css";