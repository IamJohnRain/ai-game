// packages/zippack/test/zippack.test.ts —— 不可信压缩包的攻防验收
// 每个用例对应一类真实攻击面：炸弹、穿越、嵌套、符号链接、伪造头部、篡改数据、条目洪水。
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { randomBytes } from "node:crypto";
import { createZip, readZip, DEFAULT_UPLOAD_LIMITS, type ZipLimits } from "../src/index.ts";

const L: ZipLimits = DEFAULT_UPLOAD_LIMITS;
const ok = (name: string, data: string | Buffer) => ({ name, data });
const strategy = `function onInit(ctx) {}\nfunction onTurn(state) { return [{ type: "wait" }]; }\n`;

test("正常压缩包：读取 strategy.js / meta.json / README.md", () => {
  const zip = createZip([ok("strategy.js", strategy), ok("meta.json", '{"name":"玄武"}'), ok("README.md", "# 说明")]);
  const res = readZip(zip, L);
  assert.equal(res.ok, true, res.ok ? "" : `${res.reason}: ${res.detail}`);
  if (!res.ok) return;
  assert.deepEqual(res.entries.map((e) => e.name), ["strategy.js", "meta.json", "README.md"]);
  assert.equal(res.entries[0]!.data.toString("utf8"), strategy);
  assert.equal(res.entries[0]!.method, 8);
});

test("体积上限：超过 200KB 的压缩包直接拒绝（不进入解析）", () => {
  // 注意要用不可压缩的随机数据，否则 300KB 的重复字符会被 deflate 压到几百字节（这正说明压缩比检查为什么必要）
  const big = createZip([ok("strategy.js", randomBytes(300 * 1024))]);
  assert.ok(big.length > L.maxZipBytes);
  const res = readZip(big, L);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "TOO_LARGE");
});

test("压缩炸弹：10MB 全零数据压成几 KB，必须按压缩比/单条上限拒绝", () => {
  // 直接构造：10MB 的 0 用 deflate 压到 ~10KB，绕过 createZip 的体积感
  const bomb = deflateRawSync(Buffer.alloc(10 * 1024 * 1024), { level: 9 });
  const zip = buildZipWithRawPayload("strategy.js", bomb, 10 * 1024 * 1024, crc32(Buffer.alloc(10 * 1024 * 1024)));
  assert.ok(zip.length < L.maxZipBytes, `炸弹样本本身应小于上限，实际 ${zip.length}`);
  const res = readZip(zip, L);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(["ENTRY_TOO_LARGE", "RATIO_EXCEEDED", "TOTAL_TOO_LARGE"].includes(res.reason), `实际 ${res.reason}: ${res.detail}`);
  }
});

test("解压输出上限：即使声明尺寸撒谎（声明小、实际大），也被 maxOutputLength 拦住", () => {
  const raw = Buffer.alloc(2 * 1024 * 1024); // 2MB 实际数据
  const payload = deflateRawSync(raw, { level: 9 });
  // 中央目录里把 uncompressedSize 谎报成 100 字节，CRC 也随便填
  const zip = buildZipWithRawPayload("strategy.js", payload, 100, 12345);
  const res = readZip(zip, L);
  assert.equal(res.ok, false, "撒谎的尺寸必须被识别");
  if (!res.ok) assert.ok(["ENTRY_TOO_LARGE", "BAD_DATA", "BAD_CRC"].includes(res.reason), `实际 ${res.reason}: ${res.detail}`);
});

test("条目洪水：条目数超限直接拒绝", () => {
  const many = Array.from({ length: L.maxEntries + 5 }, (_, i) => ok(`f${i}.js`, "x"));
  const res = readZip(createZip(many), L);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "ENTRY_COUNT");
});

test("路径穿越、绝对路径、反斜杠、目录项、子目录一律拒绝", () => {
  const cases: [string, string][] = [
    ["strategy.js/../../../../etc/passwd", "PATH_TRAVERSAL"],
    ["../strategy.js", "PATH_TRAVERSAL"],
    ["/strategy.js", "ABSOLUTE_PATH"],
    ["C:strategy.js", "ABSOLUTE_PATH"],
    ["sub\\strategy.js", "BACKSLASH"],
    ["dir/", "DIRECTORY_ENTRY"],
    ["a/b/c/d/e/f/strategy.js", "NOT_WHITELISTED"],
  ];
  for (const [name, expected] of cases) {
    const res = readZip(createZip([ok(name, strategy)]), L);
    assert.equal(res.ok, false, `${name} 应被拒绝`);
    if (!res.ok) assert.equal(res.reason, expected, `${name} 期望 ${expected}，实际 ${res.reason}`);
  }
});

test("嵌套压缩包被拒绝（并且永远不会被解压）", () => {
  const inner = createZip([ok("strategy.js", strategy)]);
  for (const name of ["inner.zip", "payload.gz", "a.tar", "x.7z"]) {
    const res = readZip(createZip([ok(name, inner)]), L);
    assert.equal(res.ok, false, `${name} 应被拒绝`);
    if (!res.ok) assert.equal(res.reason, "NOT_WHITELISTED", `${name} 实际 ${res.reason}`);
  }
});

test("白名单外的文件（脚本、可执行、隐藏文件）被拒绝", () => {
  for (const name of ["evil.sh", ".env", "package.json", "index.js", "STRATEGY.JS"]) {
    const res = readZip(createZip([ok(name, "x")]), L);
    assert.equal(res.ok, false, `${name} 应被拒绝`);
    if (!res.ok) assert.equal(res.reason, "NOT_WHITELISTED");
  }
});

test("重复条目被拒绝", () => {
  const res = readZip(createZip([ok("strategy.js", strategy), ok("strategy.js", strategy)]), L);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "DUPLICATE_ENTRY");
});

test("加密条目、不支持的压缩方法、符号链接被拒绝", () => {
  const encrypted = tamperCentralFlag(createZip([ok("strategy.js", strategy)]), (buf, cdStart) => buf.writeUInt16LE(0x0001, cdStart + 8));
  const enc = readZip(encrypted, L);
  assert.equal(enc.ok, false);
  if (!enc.ok) assert.equal(enc.reason, "ENCRYPTED");

  const method = tamperCentralFlag(createZip([ok("strategy.js", strategy)]), (buf, cdStart) => buf.writeUInt16LE(12, cdStart + 10));
  const meth = readZip(method, L);
  assert.equal(meth.ok, false);
  if (!meth.ok) assert.equal(meth.reason, "UNSUPPORTED_METHOD");

  const symlink = tamperCentralFlag(createZip([ok("strategy.js", strategy)]), (buf, cdStart) => buf.writeUInt32LE(0xa1ff0000, cdStart + 38));
  const sym = readZip(symlink, L);
  assert.equal(sym.ok, false);
  if (!sym.ok) assert.equal(sym.reason, "SYMLINK");
});

test("篡改数据被 CRC 拦截；垃圾字节与截断文件被结构校验拦截", () => {
  const zip = createZip([ok("strategy.js", strategy)]);
  // 篡改压缩数据段里的一个字节
  const cd = findCentralDirOffset(zip);
  const localNameStart = 30;
  const dataStart = localNameStart + "strategy.js".length;
  const tampered = Buffer.from(zip);
  tampered[dataStart + 2] = tampered[dataStart + 2]! ^ 0xff;
  const res = readZip(tampered, L);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(["BAD_CRC", "BAD_DATA"].includes(res.reason), `实际 ${res.reason}`);
  assert.ok(cd > 0);

  const garbage = readZip(Buffer.from("这不是一个 zip 文件，只是一段普通文本".repeat(10)), L);
  assert.equal(garbage.ok, false);
  if (!garbage.ok) assert.ok(["BAD_CENTRAL_DIR", "BAD_SIGNATURE"].includes(garbage.reason));

  const truncated = readZip(zip.subarray(0, zip.length - 10), L);
  assert.equal(truncated.ok, false, "截断文件应被拒绝");

  const empty = readZip(Buffer.alloc(0), L);
  assert.equal(empty.ok, false);
});

test("存储方式（method=0）的压缩包可正常读取", () => {
  const res = readZip(createZip([ok("strategy.js", strategy)], { store: true }), L);
  assert.equal(res.ok, true, res.ok ? "" : `${res.reason}: ${res.detail}`);
  if (res.ok) assert.equal(res.entries[0]!.method, 0);
});

test("最坏计算量有上界：白名单 + 条目上限 + 输出上限共同保证（无递归、无超时依赖）", () => {
  // 结构上：只解析中央目录 + 只解压 ≤maxEntries 条、每条 ≤maxEntryUncompressed 的内容
  const worstCaseBytes = L.maxEntries * L.maxEntryUncompressedBytes;
  assert.equal(worstCaseBytes, 8 * 256 * 1024);
  assert.ok(L.maxTotalUncompressedBytes <= worstCaseBytes);
  // 压缩包自身体积上限同时也限制了输入规模
  assert.equal(L.maxZipBytes, 200 * 1024);
});

// ---------------- 测试辅助：手工构造中央目录，用于伪造字段 ----------------
function findCentralDirOffset(buf: Buffer): number {
  const eocd = buf.length - 22;
  return buf.readUInt32LE(eocd + 16);
}

function tamperCentralFlag(buf: Buffer, mutate: (b: Buffer, cdStart: number) => void): Buffer {
  const copy = Buffer.from(buf);
  mutate(copy, findCentralDirOffset(copy));
  return copy;
}

/** 用给定的压缩载荷与（可能撒谎的）声明尺寸拼出一个单条目 zip */
function buildZipWithRawPayload(name: string, payload: Buffer, declaredUncompressed: number, declaredCrc: number): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(declaredCrc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(declaredUncompressed, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(declaredCrc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(declaredUncompressed, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, nameBuf, payload]);
  const cd = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}