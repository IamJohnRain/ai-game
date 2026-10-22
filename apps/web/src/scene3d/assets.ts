// apps/web/src/scene3d/assets.ts —— 三维素材清单（全部 CC0，来源与许可见 apps/web/src/assets/ATTRIBUTION.md）
//
// 为什么把"哪个格子用哪个模型"集中在一处：
//   素材是外来的、可替换的（换一套美术只需要改这个文件里的路径与尺寸），
//   而世界构建与坦克渲染只认"给什么用什么"。加载失败会退回过程式几何，所以这里的路径写错也不会黑屏。
//
// 归一化口径（span）：模型一律按"水平最大跨度占几格"缩放——不同来源的模型单位天差地别，
//   按格子归一化后就不会出现"树比坦克大十倍"。
import treeUrl from "../assets/models/kenney/detail-tree.glb?url";
import treeLargeUrl from "../assets/models/kenney/detail-tree-large.glb?url";
import rocksUrl from "../assets/models/kenney/detail-rocks.glb?url";
import crystalUrl from "../assets/models/kenney/detail-crystal.glb?url";
import colormapUrl from "../assets/models/kenney/colormap.png?url";
import tankUrl from "../assets/models/tank-quaternius.glb?url";
import type { TankForward } from "./tankModel.ts";
import type { WorldModels } from "./world.ts";

export interface ModelApi {
  /** GLB 内部引用的贴图名 → 打包后的实际地址（Kenney 的模型共用一个 colormap） */
  textures: Record<string, string>;
  world: WorldModels;
  /** forward：素材自己的车头朝向（默认 +Z）。换素材时先看炮管指向哪边，别让代码猜。 */
  tank?: { url: string; span: number; forward?: TankForward };
}

export const MODEL_API: ModelApi = {
  textures: { "colormap.png": colormapUrl },
  world: {
    // 森林主形态用针叶树、副形态用大冠层树（同一套美术，两种剪影）
    tree: { url: treeUrl, span: 1.0 },
    treeLarge: { url: treeLargeUrl, span: 1.15 },
    // 墙：岩块（比纯几何方块自然得多，且随机转向后不像"一堵墙纸"）
    rocks: { url: rocksUrl, span: 1.05 },
    // 资源点：水晶
    crystal: { url: crystalUrl, span: 0.9 },
  },
  // 车头朝 +Z：依据是 GLB 顶点里炮管那段细管在 +Z 端（尾部 −Z 的细管是排气管，
  // 两者居中后几乎等长，所以模型自己的包围盒判断不了，这里必须显式写明）。
  tank: { url: tankUrl, span: 0.98, forward: "z+" },
};
