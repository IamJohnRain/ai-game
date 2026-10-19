// apps/server/src/index.ts —— 进程入口：读配置、建存储、监听端口
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULESET_VERSION } from "@ai-game/protocol";
import { SCRIPT_PROTOCOL_VERSION } from "@ai-game/prompt";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { MapRegistry } from "./maps.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..", "..");

const config = loadConfig();
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
for (const skipped of registry.skipped()) {
  app.log.warn(`自定义地图 ${skipped.file} 加载失败，已跳过：${skipped.reason}`);
}