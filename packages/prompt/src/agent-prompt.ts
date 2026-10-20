// packages/prompt/src/agent-prompt.ts —— 注册/重签密钥时给组织者的"启动提示"
//
// 组织者复制这段文本直接粘给目标 Agent，对方就能自己开工：任务描述、任务书地址、
// 一次性密钥、上传命令一应俱全。所有细节（规则/地图规范/数值/禁用清单/自查清单）
// 都在任务书里，所以这里**刻意保持极简**——不再重复一遍规则，避免两处维护。
import { DEFAULT_UPLOAD_LIMITS_PUBLIC } from "./task-doc.ts";
import { formatBytes } from "./format.ts";

export interface AgentPromptOptions {
  /** 任务书地址（免登录） */
  taskDocUrl: string;
  /** 上传接口地址 */
  uploadUrl: string;
  /** 练习通道地址（可选：给了就提示"先自测再交卷"） */
  practiceUrl?: string;
  /** 练习配额（与 practiceUrl 一起给） */
  practiceQuota?: number;
  /** 一次性密钥（明文只在此刻存在） */
  key: string;
  agentName?: string;
  modelName?: string;
  /** 上传限制：把"脚本行数 / zip 体积"这两个硬指标写进提示 */
  limits?: { zipMaxBytes: number; maxScriptLines: number };
}

export function renderAgentPrompt(opts: AgentPromptOptions): string {
  const limits = opts.limits ?? DEFAULT_UPLOAD_LIMITS_PUBLIC;
  const who = opts.agentName
    ? `你是参赛 Agent「${opts.agentName}」${opts.modelName ? `（模型 ${opts.modelName}）` : ""}。`
    : "";
  return [
    `${who}任务：用 JavaScript 写一份坦克对战策略脚本（单文件 strategy.js，≤ ${limits.maxScriptLines} 行），打成 zip 上传参赛（≤ ${formatBytes(limits.zipMaxBytes)}）。`,
    "完整规则、地图规范、数值表、上传规范与自查清单都在任务书里，请先完整读一遍再动手（任务书免登录）：",
    "",
    `  ${opts.taskDocUrl}`,
    "",
    `一次性密钥（只显示这一次、只能成功使用一次）：${opts.key}`,
    "上传命令（打包好后直接执行）：",
    "",
    `  curl -X POST ${opts.uploadUrl} \\`,
    `    -H "Authorization: Bearer ${opts.key}" \\`,
    '    -H "Content-Type: application/zip" \\',
    "    --data-binary @strategy.zip",
    "",
    ...(opts.practiceUrl
      ? [
        `自测（推荐）：先用同一把密钥调 POST ${opts.practiceUrl} 传同样的 zip，会跑完整校验 + 两局标尺对局（对手只有挂机者与平台基线），`,
        `　　　　　 不消耗这把密钥、不计成绩，配额 ${opts.practiceQuota ?? 5} 次；跑通再正式提交。`,
        "",
      ]
      : []),
    "要点：只允许使用全局 MAP / RULES / API；不要写死任何地图坐标与尺寸，开局用 API.pathFind 现算（校验会对你没见过的每一张地图各跑一遍）；",
    "禁用清单（Date、Math.random、require、eval、while(true) 等）见任务书 §5，上传规范见 §4，提交前照 §11 逐条自查。",
  ].join("\n");
}