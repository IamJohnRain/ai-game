// packages/zippack/src/index.ts —— 加固的 ZIP 读写（不依赖第三方库）
//
// 为什么自己写：上传的是**外部 Agent 提交的不可信压缩包**，必须能对"压缩炸弹、路径穿越、
// 嵌套压缩、符号链接、超深目录、加密条目"逐条给出确定性拒绝，而通用库通常把这些"当特性"。
//
// 本实现的安全性质（可被测试直接验证）：
//  1. 永不递归。只解析中央目录 + 按偏移读取被白名单允许的条目，结构上不存在"解压死循环"。
//  2. 白名单按**扁平文件名**匹配：任何带目录的名字（含 ../../、a/b/c）一律拒绝，
//     因此"压缩过深/穿越写盘"在入口就被挡掉，根本不会发生解压。
//  3. 每个条目解压时传入 zlib 的 maxOutputLength 硬上限：即使声明尺寸撒谎，输出也不可能超限。
//  4. 三重体积约束：单条未压缩上限、总未压缩上限、压缩比上限（防炸弹）。
//  5. 校验 CRC32 与声明尺寸，篡改/伪造的条目会被拒。
//  6. 最坏计算量上界 = maxEntries × maxEntryUncompressed，可静态估算，不需要超时兜底。

import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipRejectReason =
  | "TOO_LARGE" | "BAD_SIGNATURE" | "BAD_CENTRAL_DIR" | "TRUNCATED" | "ZIP64_UNSUPPORTED"
  | "ENTRY_COUNT" | "DUPLICATE_ENTRY" | "ENTRY_TOO_LARGE" | "TOTAL_TOO_LARGE" | "RATIO_EXCEEDED"
  | "PATH_TRAVERSAL" | "ABSOLUTE_PATH" | "BACKSLASH" | "DIRECTORY_ENTRY" | "NAME_TOO_LONG"
  | "NESTED_ARCHIVE" | "SYMLINK" | "ENCRYPTED" | "UNSUPPORTED_METHOD" | "NOT_WHITELISTED"
  | "BAD_DATA" | "BAD_CRC";

export interface ZipLimits {
  /** 压缩包体积上限（字节） */
  maxZipBytes: number;
  /** 条目数上限 */
  maxEntries: number;
  /** 单个条目的未压缩体积上限 */
  maxEntryUncompressedBytes: number;
  /** 所有条目的未压缩体积总和上限 */
  maxTotalUncompressedBytes: number;
  /** 总压缩比上限：totalUncompressed / zipBytes 超过即拒 */
  maxRatio: number;
  maxNameLength: number;
  /** 允许的文件名白名单（扁平名，不含目录分隔符） */
  allowedNames: readonly string[];
}

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  uncompressedSize: number;
  data: Buffer;
}

export type ZipResult =
  | { ok: true; entries: ZipEntry[]; totalUncompressed: number }
  | { ok: false; reason: ZipRejectReason; detail: string };

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const NESTED_EXT = /\.(zip|gz|tgz|tar|7z|rar|jar|xz|bz2|lzma|zst|zipx|cab|iso)$/i;

export function readZip(buf: Buffer, limits: ZipLimits): ZipResult {
  if (buf.length === 0) return reject("BAD_SIGNATURE", "空文件");
  if (buf.length > limits.maxZipBytes) {
    return reject("TOO_LARGE", `压缩包 ${buf.length} 字节，上限 ${limits.maxZipBytes} 字节`);
  }

  // ---- 1) 定位 EOCD（从尾部往前找，最多 64KB + 22 字节）----
  const minEocd = Math.max(0, buf.length - (0xffff + 22));
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return reject("BAD_CENTRAL_DIR", "找不到 EOCD 记录（不是合法 zip 或已截断）");

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return reject("ZIP64_UNSUPPORTED", "不支持 ZIP64（避免额外的解析攻击面）");
  }
  if (cdOffset + cdSize > eocd) return reject("BAD_CENTRAL_DIR", "中央目录越界（文件被篡改或截断）");
  if (entryCount > limits.maxEntries) {
    return reject("ENTRY_COUNT", `条目数 ${entryCount} 超过上限 ${limits.maxEntries}`);
  }

  // ---- 2) 遍历中央目录并逐条判定 ----
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buf.length) return reject("TRUNCATED", `第 ${i} 条中央目录记录越界`);
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL) return reject("BAD_CENTRAL_DIR", `第 ${i} 条中央目录签名错误`);

    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const declaredCrc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttrs = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);

    if (cursor + 46 + nameLen + extraLen + commentLen > buf.length) {
      return reject("TRUNCATED", `第 ${i} 条元数据越界`);
    }
    const rawName = buf.subarray(cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    // 名字必须是 UTF-8/ASCII 且不含 NUL（拒绝奇怪编码带来的歧义）
    const name = rawName.toString("utf8");
    if (name.includes("\0") || rawName.includes(0)) return reject("BAD_DATA", `第 ${i} 条文件名含 NUL 字节`);

    if (name.length > limits.maxNameLength) return reject("NAME_TOO_LONG", `文件名过长：${name.length}`);
    if ((flags & 0x1) !== 0) return reject("ENCRYPTED", `条目 ${name} 被加密（不允许）`);
    if (name.includes("\\")) return reject("BACKSLASH", `条目名含反斜杠：${name}`);
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return reject("ABSOLUTE_PATH", `条目名为绝对路径：${name}`);
    if (name.endsWith("/")) return reject("DIRECTORY_ENTRY", `不允许目录条目：${name}`);
    const segments = name.split("/");
    if (segments.length > 1) {
      // 白名单都是扁平名，出现目录即拒（同时覆盖 ../../ 与"过深嵌套"两种情况）
      if (segments.some((s) => s === ".." || s === "." || s === "")) {
        return reject("PATH_TRAVERSAL", `条目名包含穿越路径：${name}`);
      }
      return reject("NOT_WHITELISTED", `不允许子目录（只接受扁平文件）：${name}`);
    }
    if (!limits.allowedNames.includes(name)) return reject("NOT_WHITELISTED", `不允许的文件：${name}`);
    if (seen.has(name)) return reject("DUPLICATE_ENTRY", `重复条目：${name}`);
    seen.add(name);
    if (NESTED_EXT.test(name)) return reject("NESTED_ARCHIVE", `不允许嵌套压缩包：${name}`);
    // Unix 符号链接：外部属性高 16 位是文件模式，0xA000 表示 symlink
    if (((externalAttrs >>> 16) & 0xf000) === 0xa000) return reject("SYMLINK", `条目是符号链接：${name}`);
    if (method !== 0 && method !== 8) return reject("UNSUPPORTED_METHOD", `条目 ${name} 使用了不支持的压缩方法 ${method}`);
    if (uncompSize > limits.maxEntryUncompressedBytes) {
      return reject("ENTRY_TOO_LARGE", `条目 ${name} 声明未压缩 ${uncompSize} 字节，超过单条上限 ${limits.maxEntryUncompressedBytes}`);
    }
    if (compSize > buf.length) return reject("TRUNCATED", `条目 ${name} 声明压缩体积超过文件本身`);
    if (compSize > 0 && uncompSize / compSize > limits.maxRatio) {
      return reject("RATIO_EXCEEDED", `条目 ${name} 压缩比 ${Math.round(uncompSize / compSize)}:1 超过上限 ${limits.maxRatio}:1`);
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      return reject("TOTAL_TOO_LARGE", `未压缩总量超过上限 ${limits.maxTotalUncompressedBytes} 字节`);
    }
    if (buf.length > 0 && totalUncompressed / buf.length > limits.maxRatio) {
      return reject("RATIO_EXCEEDED", `总压缩比 ${Math.round(totalUncompressed / buf.length)}:1 超过上限 ${limits.maxRatio}:1`);
    }

    // ---- 3) 读本地头并解压（带输出硬上限，不递归）----
    if (localOffset + 30 > buf.length) return reject("TRUNCATED", `条目 ${name} 本地头越界`);
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) return reject("BAD_CENTRAL_DIR", `条目 ${name} 本地头签名错误`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) return reject("TRUNCATED", `条目 ${name} 数据越界`);
    const payload = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      if (compSize !== uncompSize) return reject("BAD_DATA", `条目 ${name} 存储方式下大小不一致`);
      data = Buffer.from(payload);
    } else {
      try {
        data = inflateRawSync(payload, { maxOutputLength: limits.maxEntryUncompressedBytes });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return /maxOutputLength|output length|larger than/i.test(message)
          ? reject("ENTRY_TOO_LARGE", `条目 ${name} 解压结果超过单条上限`)
          : reject("BAD_DATA", `条目 ${name} 解压失败：${message}`);
      }
    }
    if (data.length !== uncompSize) {
      return reject("BAD_DATA", `条目 ${name} 实际解压 ${data.length} 字节，与声明 ${uncompSize} 不符`);
    }
    if ((crc32(data) >>> 0) !== declaredCrc) return reject("BAD_CRC", `条目 ${name} CRC 校验失败`);
    entries.push({ name, method: method as 0 | 8, compressedSize: compSize, uncompressedSize: uncompSize, data });
  }

  return { ok: true, entries, totalUncompressed };
}

function reject(reason: ZipRejectReason, detail: string): ZipResult {
  return { ok: false, reason, detail };
}

// ---------------------------------------------------------------- 写 zip（生成测试样本 / CLI 打包含用）
export interface ZipWriteEntry { name: string; data: string | Buffer }

export function createZip(inputs: ZipWriteEntry[], options: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const input of inputs) {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, "utf8");
    const nameBuf = Buffer.from(input.name, "utf8");
    const crc = crc32(data) >>> 0; // Node 的 crc32 返回有符号 int32，写入前必须转无符号
    const method = options.store ? 0 : 8;
    const payload = method === 8 ? deflateRawSync(data, { level: 9 }) : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 名字
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);          // time/date 置零：让压缩包可复现
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4);    // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 普通文件（非 symlink）
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 供服务端使用的默认上限（与上传接口的对外承诺一致） */
export const DEFAULT_UPLOAD_LIMITS: ZipLimits = {
  maxZipBytes: 200 * 1024,           // 需求：zip 包 ≤ 200KB
  maxEntries: 8,
  maxEntryUncompressedBytes: 256 * 1024,
  maxTotalUncompressedBytes: 320 * 1024,
  maxRatio: 200,
  maxNameLength: 64,
  allowedNames: ["strategy.js", "meta.json", "README.md"],
};