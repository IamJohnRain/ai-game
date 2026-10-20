// apps/server/src/uploadStages.ts —— 上传/练习失败阶段的对外词汇表（任务书 §3 的 stage 字段）
// 放在这里是因为上传接口与练习通道共用同一套"五阶段 + 闸门"语义，避免两处各写一份 switch 漂移。
import type { CheckStatus } from "@ai-game/script-check";

export type UploadStage =
  | "auth" | "revisions" | "attempts" | "quota" | "size" | "zip" | "content"
  | "static" | "compile" | "fuzz" | "smoke";

/** 脚本校验的终态 → 对外 stage（与任务书里列的失败原因一一对应） */
export function mapCheckStatusToStage(status: CheckStatus | string): UploadStage {
  switch (status) {
    case "STATIC_REJECT": return "static";
    case "COMPILE_ERROR":
    case "INIT_ERROR": return "compile";
    case "SMOKE_FAILED": return "smoke";
    case "EXTRACT_FAILED": return "content";
    default: return "fuzz";
  }
}