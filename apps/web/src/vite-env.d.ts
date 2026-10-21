// apps/web/src/vite-env.d.ts —— Vite 资源导入的类型声明（本项目只用到 ?raw 文本导入）
declare module "*.svg?raw" {
  const content: string;
  export default content;
}

// 三维素材（glTF 二进制）与随身贴图：以 URL 形式交给 three 的加载器
declare module "*.glb?url" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.png?url" {
  const src: string;
  export default src;
}

declare module "*.css";