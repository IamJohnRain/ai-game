// packages/prompt/src/format.ts —— 对外文本里的小工具（任务书与启动 prompt 共用，避免两处各写一份）
export function formatBytes(n: number): string {
  if (n % 1024 === 0) return `${n / 1024} KB`;
  return `${n} 字节`;
}