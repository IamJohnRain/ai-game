// packages/orchestrator/src/index.ts —— 赛事编排与战报（CLI 与服务端共用）
// 平台只有一条参赛链路：外部 Agent 上传脚本 → 校验入库 → 组织 1v1 循环赛 → 回放/战报。
// （历史上这里还有一条"平台调用大模型生成脚本"的链路，已按需求整体删除。）
export * from "./report.ts";
export * from "./tournament.ts";