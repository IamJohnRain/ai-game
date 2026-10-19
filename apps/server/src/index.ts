// apps/server/src/index.ts —— 进程入口：读配置、建存储、监听端口
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULESET_VERSION } from "@ai-game/protocol";
import { SCRIPT_PROTOCOL_VERSION } from "@ai-game/prompt";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { MapRegistry } from "./maps.ts";
import { createApp } from "./app.ts";
import { AUTH_PASSWORD_FILE, readOrCreatePasswordFile } from "./auth.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..", "..");

const config = loadConfig();

// 登录密码：优先环境变量 / `.env`（AI_GAME_AUTH_PASSWORD）；没配置就自动生成一份随机密码落到
// data/auth.password（0600，data/ 已被 .gitignore 排除）——仓库里不含任何默认密码。
let passwordSource = "AI_GAME_AUTH_PASSWORD";
let passwordGenerated = false;
if (!config.auth.password) {
  const { password, created } = readOrCreatePasswordFile(join(config.dataDir, AUTH_PASSWORD_FILE));
  config.auth.password = password;
  passwordGenerated = created;
  passwordSource = `data/${AUTH_PASSWORD_FILE}`;
}
const store = new Store(config.dbPath, config.masterKey);
const registry = new MapRegistry(join(config.dataDir, "maps"));
const { app } = await createApp({ config, store, registry });

const close = async () => {
  store.close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: config.port, host: config.host });
app.log.info(`AI 坦克对战平台服务已启动：http://${config.host}:${config.port}（ruleset-${RULESET_VERSION}，脚本协议 ${SCRIPT_PROTOCOL_VERSION}）`);
app.log.info(`地图注册表：${registry.ids().join(", ")}`);
app.log.info(`登录账号：${config.auth.user}（密码来自 ${passwordSource}）`);
if (passwordGenerated) {
  app.log.warn(
    `⚠ 未配置 AI_GAME_AUTH_PASSWORD，已生成随机密码并写入 ${join(config.dataDir, AUTH_PASSWORD_FILE)}：` +
      `用 cat 查看并妥善保存（文件权限 0600）；想换成自己的密码，就在 ~/ai-game/.env 里设置 AI_GAME_AUTH_PASSWORD 后重启（详见 docs/07 §6）`,
  );
}
for (const skipped of registry.skipped()) {
  app.log.warn(`自定义地图 ${skipped.file} 加载失败，已跳过：${skipped.reason}`);
}