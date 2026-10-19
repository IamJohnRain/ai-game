// packages/sandbox/src/bootstrap.ts —— 注入沙箱的启动脚本（脚本可见的世界仅此而已）
// 设计：唯一的宿主桥是 __hostApi(name, argsJson) → JSON 字符串。
// 沙箱内不暴露任何宿主函数对象，只传 JSON 值，避免逃逸面。

export const API_METHOD_NAMES = [
  "chebyshev", "euclid", "dirTo", "step", "isPassable", "hasLOS", "pathFind", "neighbors",
  "isWall", "isWater", "isForest", "isAmmo", "isFuel", "isResource", "isDeposit", "isSpawn",
  "random", "randomInt", "log",
] as const;

/** 生成 bootstrap：注入 MAP / RULES（深冻结）与 API（唯一入口 __hostApi） */
export function buildBootstrap(mapJson: string, rulesJson: string): string {
  const methodDefs = API_METHOD_NAMES.map((m) => `  ${m}: function(){ return __call(${JSON.stringify(m)}, Array.prototype.slice.call(arguments)); },`).join("\n");
  return `
"use strict";
var __deepFreeze = function (o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) __deepFreeze(o[k]); }
  }
  return o;
};
globalThis.MAP = __deepFreeze(JSON.parse(${JSON.stringify(mapJson)}));
globalThis.RULES = __deepFreeze(JSON.parse(${JSON.stringify(rulesJson)}));
var __call = function (name, args) {
  var raw = __hostApi(name, JSON.stringify(args || []));
  var parsed = JSON.parse(raw);
  if (parsed && parsed.__error) { throw new Error(parsed.__error); }
  return parsed ? parsed.value : null;
};
globalThis.API = Object.freeze({
  version: "1.0",
${methodDefs}
});
// 纵深防御：沙箱层面也切断非确定性来源与动态代码执行（静态扫描之外的第二道闸）
try { Object.defineProperty(Math, "random", { value: function () { throw new Error("Math.random 不可用：请使用 API.random() / API.randomInt()"); }, writable: false, configurable: false }); } catch (e) {}
try { Object.defineProperty(globalThis, "Date", { value: undefined, writable: false, configurable: false }); } catch (e) {}
try { Object.defineProperty(globalThis, "eval", { value: undefined, writable: false, configurable: false }); } catch (e) {}
try { Object.defineProperty(globalThis, "Function", { value: undefined, writable: false, configurable: false }); } catch (e) {}
try { Object.defineProperty(globalThis, "WebAssembly", { value: undefined, writable: false, configurable: false }); } catch (e) {}
try { Object.defineProperty(globalThis, "Atomics", { value: undefined, writable: false, configurable: false }); } catch (e) {}
`;
}

export const STRATEGY_ENTRY = `;globalThis.__strategy = {
  onInit: typeof onInit === "function" ? onInit : null,
  onTurn: typeof onTurn === "function" ? onTurn : null,
  meta: typeof META !== "undefined" ? META : null
};`;