# 素材来源与许可（apps/web/src/assets）

本项目的美术素材分两类：**自己画的矢量 SVG**（`tiles/*.svg`，MIT，与代码同许可）与**外部 CC0 素材**（下表）。
下表素材均为 **CC0 1.0（公共领域奉献）**：可商用、可再分发、**无需署名**——这里逐条记下来是为了日后可追溯来源（以及换素材时知道该动哪些文件）。

| 文件 | 内容 | 作者 | 来源 | 许可 |
| --- | --- | --- | --- | --- |
| `models/kenney/detail-tree.glb`、`detail-tree-large.glb` | 针叶树 / 大冠层树（三维，森林格） | Kenney | [Tower Defense Kit](https://kenney.nl/assets/tower-defense-kit) | CC0 1.0 |
| `models/kenney/detail-rocks.glb`、`detail-rocks-large.glb` | 岩块（三维，墙格） | Kenney | 同上 | CC0 1.0 |
| `models/kenney/detail-crystal.glb`、`detail-crystal-large.glb` | 水晶（三维，资源点） | Kenney | 同上 | CC0 1.0 |
| `models/kenney/colormap.png` | 上面这些模型共用的调色板贴图（GLB 内部按相对路径引用它） | Kenney | 同上 | CC0 1.0 |
| `models/tank-quaternius.glb` | 低模坦克（三维，含车体/炮塔/炮管/履带四个图元） | Quaternius | [poly.pizza/m/Dc4k4CooN3](https://poly.pizza/m/Dc4k4CooN3) | CC0 1.0 |
| `tiles-kenney/ground-dirt.png`、`ground-sand.png`、`ground-grass.png` | 泥地 / 沙地 / 草地（二维，地面与森林底） | Kenney | [Top-down Tanks](https://kenney.nl/assets/top-down-tanks) | CC0 1.0 |
| `tiles-kenney/tree-large.png`、`tree-small.png` | 大小两种树（二维，森林格） | Kenney | 同上 | CC0 1.0 |
| `tiles-kenney/barrel-red.png` | 油桶（二维，加油点） | Kenney | 同上 | CC0 1.0 |
| `tiles-kenney/tank-{red,blue,green,beige}.png` | 四色俯视坦克（二维，按座位取色） | Kenney | 同上 | CC0 1.0 |

## 落地时做的处理

- **只取用到的文件**：两个上游包合计 11MB / 900+ 文件，这里只挑选了 16 个文件（合计约 350KB），重命名成"用途-形态"的英文名，方便在代码里检索。
- **不引入额外依赖**：三维用 three 自带的 `GLTFLoader` 读 `.glb`；二维用 `Image` + canvas 栅格化（沿用 `sprites.ts` 既有的缓存机制）。
- **可作为兜底回退**：三维场景在模型加载失败时会退回过程式几何（`world.ts`/`tanks.ts` 里的占位网格），二维在图片解码失败时退回纯色块，所以素材缺失不会导致白屏。
- **口径归一化**：三维模型一律按"水平最大跨度占几格"缩放（见 `scene3d/assets.ts` 的 span），二维位图一律等比铺满整格——不同来源的素材单位不同，靠这一步保证"树不会比坦克大十倍"。

## 许可原文（留存备查）

- Kenney：包内 `Sample.png` 印有 "CC0 1.0 … free to use in personal, educational and commercial projects. Written permission not required"。许可正文：<https://creativecommons.org/publicdomain/zero/1.0/>
- Quaternius（via poly.pizza）：模型页标注 `Licence: CC0 1.0`。许可正文同上。