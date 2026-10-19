// packages/sandbox/src/index.ts —— 沙箱出口
export * from "./bootstrap.ts";
export * from "./quickjs.ts";
export { LocalController } from "@ai-game/engine";
export type { TurnController, ControllerTurnResult, ScriptGlobals } from "@ai-game/engine";