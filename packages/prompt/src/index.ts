// packages/prompt/src/index.ts —— 平台对外文本（任务书、数值表）的渲染入口
// 注意：本包只服务**外部 Agent 自助接入**这一条链路；平台不再调用任何大模型，因此没有提示词渲染器。
export * from "./rules-table.ts";
export * from "./task-doc.ts";