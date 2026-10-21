// apps/web/src/scene3d/textures.ts —— 三维用到的程序式贴图（全部现场画进 canvas，不引入图片素材）
//
// 为什么程序式：这些贴图都是"一点柔和的形状"（火光、烟、接触阴影、飘字），
// 用 canvas 画比打包 PNG 更小、更可控（颜色/浓度随代码调），也不会因为素材文件缺失而让画面变空白。
// 三处分用：接触阴影（world/tanks）、火花与烟雾（effects）、飘字（effects）。
import * as THREE from "three";

/** 径向渐变光斑：中心实、边缘透明。火光、火花、接触阴影都由它换颜色与混合方式得到 */
export function radialTexture(inner: string, outer = "rgba(0,0,0,0)", size = 128): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.45, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 接触阴影：中心浓、边缘渐隐的圆斑。用它垫在物体脚下，物体才不会像"飘在地板上"——
 * 平行光阴影贴图只在中小地图上开，这一层是全场通用的廉价"落地感"。
 */
export function shadowTexture(size = 128): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(0.75, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 烟雾：在径向渐变上撒噪声，否则一团纯灰看着像气泡 */
export function smokeTexture(size = 128): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.6, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 0.6 + Math.random() * 0.8;
    img.data[i] = Math.min(255, img.data[i]! * n);
    img.data[i + 1] = Math.min(255, img.data[i + 1]! * n);
    img.data[i + 2] = Math.min(255, img.data[i + 2]! * n);
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 无缝表面纹理（泥土/混凝土/石面的中性噪点）：地面与墙体用同一张，靠实例颜色染色，
 * 于是"一张灰度贴图"就能让所有地面不再是纯色塑料板。
 *
 * 无缝是硬要求：铺满整张地图时接缝会连成网格线，一眼看穿。
 * 做法是把每个噪点块在 x/y 两个方向（含对角）各偏移 ±size 重画一遍 —— 落在边缘的部分会自动接回另一侧。
 */
export function surfaceTexture(opts: { size?: number; grain?: number; pebbles?: number; streaks?: number } = {}): THREE.Texture {
  const size = opts.size ?? 256;
  const grain = opts.grain ?? 0.16;
  const pebbles = opts.pebbles ?? 90;
  const streaks = opts.streaks ?? 14;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#b9bcc2";
  ctx.fillRect(0, 0, size, size);

  // 逐像素细噪点：给表面"颗粒感"，密到看不出图案
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 1 + (Math.random() - 0.5) * grain * 2;
    img.data[i] = Math.min(255, img.data[i]! * n);
    img.data[i + 1] = Math.min(255, img.data[i + 1]! * n);
    img.data[i + 2] = Math.min(255, img.data[i + 2]! * n);
  }
  ctx.putImageData(img, 0, 0);

  /** 画一个形状，并在九宫格的八个方向各重画一次，确保跨边缘连续 */
  const wrapped = (draw: (dx: number, dy: number) => void) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) draw(dx * size, dy * size);
    }
  };

  // 碎石/麻点：深浅各一半，避免只往暗处走导致整体发灰
  for (let i = 0; i < pebbles; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 1 + Math.random() * 4.5;
    const light = Math.random() > 0.5;
    wrapped((dx, dy) => {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, light ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.42)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // 几道细裂纹/划痕：让表面有方向性，不至于像均匀噪点
  ctx.lineCap = "round";
  for (let i = 0; i < streaks; i++) {
    const x0 = Math.random() * size;
    const y0 = Math.random() * size;
    const len = size * (0.1 + Math.random() * 0.25);
    const ang = Math.random() * Math.PI * 2;
    const x1 = x0 + Math.cos(ang) * len;
    const y1 = y0 + Math.sin(ang) * len;
    const w = 0.8 + Math.random() * 1.4;
    wrapped((dx, dy) => {
      ctx.strokeStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.2)";
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0 + dx, y0 + dy);
      ctx.lineTo(x1 + dx, y1 + dy);
      ctx.stroke();
    });
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/**
 * 把一张贴图切成 n×n 份"错位变体"：同一块地面几何，按格分给不同偏移的材质，
 * 重复的图案就被打散了（代价只是多几个 draw call）。返回可交给 InstancedMesh 用的材质数组。
 */
export function offsetVariants(tex: THREE.Texture, makeMaterial: (t: THREE.Texture) => THREE.Material, n = 2): THREE.Material[] {
  const out: THREE.Material[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const clone = tex.clone();
      clone.needsUpdate = true;
      clone.wrapS = tex.wrapS;
      clone.wrapT = tex.wrapT;
      clone.repeat.set(1 / n, 1 / n);
      clone.offset.set(i / n, j / n);
      out.push(makeMaterial(clone));
    }
  }
  return out;
}
/** 飘字：白字描深边，压在任何地形颜色上都读得清（按 内容+颜色 缓存纹理） */
export function textTexture(text: string, color: string): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "700 46px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 9;
  ctx.strokeStyle = "rgba(4,6,11,0.92)";
  ctx.strokeText(text, 128, 42);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 42);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}