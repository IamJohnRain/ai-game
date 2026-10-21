// apps/web/src/pages/MapEditorPage.tsx —— 地图编辑器：拖拽设计 → 实时校验 → 试跑 → 保存
//
// 三种交互方式同时支持，因为不同的人习惯不同：
//   ① 从左侧"元素盘"拖到格子上（HTML5 drag & drop，落点即放置）；
//   ② 先点选画笔，再在格子上按住拖动连续画（画一笔 = 一次撤销）；
//   ③ 右侧参数面板改数值（尺寸、镜像模式、资源点产能、1v1 出生点）。
//
// 校验分三层，判据与"能不能拿去比赛"完全一致：
//   ① 结构自洽（protocol.validateMap）：镜像对称 / grid 与坐标数组一致 / 连通性 / 关键设施存在；
//   ② 玩法审计（engine.auditMap）：设施可达性、出生点两两等价、经济是否正循环、僵局风险 —— 纯本地实时算；
//   ③ 试跑（服务端 /api/maps/playtest）：用平台基线脚本在这张图上真打一局，把"能不能打起来"跑成数字。
// 保存走 /api/maps：服务端会用同一套判据再校验一遍（errors 非空即拒），并把距离参考表按实测寻路重算。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_RULESET } from "@ai-game/protocol";
import { auditMap, type MapAudit } from "@ai-game/engine";
import { api, ApiError, type MapListItem, type PlaytestResult } from "../api";
import { Badge, Banner, EmptyState, Section } from "../ui";
import {
  BRUSH_LABEL,
  DEFAULT_TUNING,
  borderWall, clearFacilities, draftFromMap, draftJson, draftStats, emptyDraft, eraseAt,
  facilityAt, isWalkable, mirrorPoints, mirrorize, paint, resizeDraft, setMeta, setNodeParams,
  setSpawn1v1Slot, setSupplyParams, setTuning, spawnsOf, terrainAt, toMap,
  type BrushId, type DraftFacility, type FacilityKind, type MapDraft,
} from "../mapDraft";
import { TILE_FALLBACK_FILL, TILE_SRC, floorSrc, onSpritesReady, preloadSprites, rasterSprite, spriteSrc, tileSrc } from "../sprites";

/** 元素盘：左侧可拖拽的画笔清单 */
const PALETTE: { group: string; items: { id: BrushId; hint: string }[] }[] = [
  {
    group: "地形",
    items: [
      { id: ".", hint: "平地：可通行，不挡视线" },
      { id: "#", hint: "墙：挡移动、挡视线" },
      { id: "~", hint: "水：挡移动，不挡视线" },
      { id: "f", hint: "森林：可通行、挡视线、站在其中受击减半" },
    ],
  },
  {
    group: "设施",
    items: [
      { id: "spawn", hint: "出生点：坦克开局位置，序号即脚本里 MAP.spawns 的顺序" },
      { id: "ammo", hint: "弹药补给点：2 分/发装填" },
      { id: "fuel", hint: "加油点：1 分/10 燃油" },
      { id: "resource", hint: "资源点：采集点，产能可在右侧调" },
      { id: "deposit", hint: "提交点：把资源交上去换分的目标" },
    ],
  },
  { group: "工具", items: [{ id: "erase", hint: "橡皮：先清设施；空地上再擦一次就恢复成平地" }] },
];

const BRUSH_ICON: Record<BrushId, string | null> = {
  ".": TILE_SRC["."]![0]!,
  "#": TILE_SRC["#"]![0]!,
  "~": TILE_SRC["~"]![0]!,
  f: TILE_SRC["f"]![0]!,
  spawn: TILE_SRC["S"]![0]!,
  ammo: TILE_SRC["B"]![0]!,
  fuel: TILE_SRC["G"]![0]!,
  resource: TILE_SRC["R"]![0]!,
  deposit: TILE_SRC["D"]![0]!,
  erase: null,
};

const FACILITY_SVG: Record<FacilityKind, string> = {
  spawn: TILE_SRC["S"]![0]!,
  ammo: TILE_SRC["B"]![0]!,
  fuel: TILE_SRC["G"]![0]!,
  resource: TILE_SRC["R"]![0]!,
  deposit: TILE_SRC["D"]![0]!,
};

const DISTANCE_LABELS: Record<string, string> = {
  spawn_to_ammoDepot: "出生点 → 最近弹药点",
  spawn_to_fuelStation: "出生点 → 最近加油点",
  spawn_to_homeResourceNode: "出生点 → 最近前哨资源点",
  spawn_to_centerResourceNode: "出生点 → 最近中央资源点",
  spawn_to_deposit: "出生点 → 提交点",
  spawn_to_oppositeSpawn: "出生点 → 对手出生点",
  centerResourceNode_to_deposit: "中央资源点 → 提交点",
};

/** 编辑器固定格子尺寸：拖拽落点清晰；图大了就滚动 */
const CELL = 30;
const MAP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function MapEditorPage() {
  const [draft, setDraft] = useState<MapDraft>(() => emptyDraft(21, 21, "my-map"));
  const [brush, setBrush] = useState<BrushId>(".");
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [customMaps, setCustomMaps] = useState<MapListItem[]>([]);
  const [allMaps, setAllMaps] = useState<MapListItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [playtest, setPlaytest] = useState<PlaytestResult | null>(null);
  const [playtesting, setPlaytesting] = useState(false);
  const [historySize, setHistorySize] = useState(0);
  const [futureSize, setFutureSize] = useState(0);

  const historyRef = useRef<MapDraft[]>([]);
  const futureRef = useRef<MapDraft[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef<{ drawing: boolean; last: string | null }>({ drawing: false, last: null });

  // ---------------- 素材就绪 → 重绘（首帧用色块兜底，就绪后换素材） ----------------
  useEffect(() => {
    const off = onSpritesReady(() => setTick((t) => t + 1));
    preloadSprites();
    setTick((t) => t + 1);
    return off;
  }, []);

  // ---------------- 服务端地图列表 ----------------
  const loadMaps = useCallback(() => {
    api
      .listMaps()
      .then((list) => {
        setAllMaps(list);
        setCustomMaps(list.filter((m) => m.custom));
      })
      .catch(() => {
        setAllMaps([]);
        setCustomMaps([]);
      });
  }, []);
  useEffect(() => loadMaps(), [loadMaps]);

  // ---------------- 本地审计（随每次编辑重算） ----------------
  const map = useMemo(() => toMap(draft), [draft]);
  const audit: MapAudit = useMemo(() => {
    try {
      return auditMap(map);
    } catch (err) {
      // 极端草稿不该让整页崩掉：把异常本身当成一条错误展示
      return {
        mapId: map.mapId, version: map.version,
        errors: [`审计无法执行：${err instanceof Error ? err.message : String(err)}`],
        warnings: [], distances: {}, spawnDistances: [],
        stats: {
          width: 0, height: 0, walkable: 0, wall: 0, water: 0, forest: 0,
          spawns: 0, ammoDepots: 0, fuelStations: 0, resourceNodes: 0, depositPoints: 0,
        },
      };
    }
  }, [map]);
  const stats = useMemo(() => draftStats(draft), [draft]);
  const idOk = MAP_ID_RE.test(draft.mapId) && !allMaps.some((m) => m.mapId === draft.mapId && !m.custom);
  const canSave = audit.errors.length === 0 && idOk;

  // ---------------- 撤销/重做 ----------------
  const syncHistoryFlags = useCallback(() => {
    setHistorySize(historyRef.current.length);
    setFutureSize(futureRef.current.length);
  }, []);
  const commit = useCallback((next: MapDraft) => {
    setDraft((cur) => {
      historyRef.current.push(cur);
      if (historyRef.current.length > 120) historyRef.current.shift();
      futureRef.current = [];
      return next;
    });
    syncHistoryFlags();
  }, [syncHistoryFlags]);
  const undo = useCallback(() => {
    setDraft((cur) => {
      const prev = historyRef.current.pop();
      if (!prev) return cur;
      futureRef.current.push(cur);
      return prev;
    });
    syncHistoryFlags();
  }, [syncHistoryFlags]);
  const redo = useCallback(() => {
    setDraft((cur) => {
      const next = futureRef.current.pop();
      if (!next) return cur;
      historyRef.current.push(cur);
      return next;
    });
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ---------------- 画布渲染 ----------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = draft.width;
    const H = draft.height;
    canvas.width = W * CELL * dpr;
    canvas.height = H * CELL * dpr;
    canvas.style.width = `${W * CELL}px`;
    canvas.style.height = `${H * CELL}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W * CELL, H * CELL);

    const drawSprite = (svg: string, x: number, y: number): boolean => {
      const raster = rasterSprite(svg, CELL, dpr);
      if (!raster) return false;
      ctx.drawImage(raster, x * CELL, y * CELL, CELL, CELL);
      return true;
    };

    // 地形（设施格先铺平地，设施图标再叠上去）
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = terrainAt(draft, x, y);
        const onFacility = Boolean(facilityAt(draft, x, y));
        const svg = onFacility ? floorSrc(x, y) : tileSrc(ch, x, y);
        if (!svg || !drawSprite(svg, x, y)) {
          ctx.fillStyle = TILE_FALLBACK_FILL[onFacility ? "." : ch] ?? TILE_FALLBACK_FILL["."]!;
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
    }
    for (const f of draft.facilities) {
      const svg = FACILITY_SVG[f.kind];
      if (!drawSprite(svg, f.x, f.y)) {
        ctx.fillStyle = "rgba(226,232,240,0.4)";
        ctx.fillRect(f.x * CELL + 6, f.y * CELL + 6, CELL - 12, CELL - 12);
      }
    }

    // 出生点序号（1v1 用的两个加金框）
    const spawns = spawnsOf(draft);
    const pair = draft.spawnsFor1v1;
    spawns.forEach((s, i) => {
      const is1v1 = (i + 1) === pair[0] || (i + 1) === pair[1];
      ctx.lineWidth = 3;
      ctx.strokeStyle = is1v1 ? "#f5c542" : "rgba(226,232,240,0.45)";
      ctx.strokeRect(s.x * CELL + 2, s.y * CELL + 2, CELL - 4, CELL - 4);
      ctx.font = `700 ${Math.floor(CELL * 0.42)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(6,8,12,0.9)";
      ctx.strokeText(String(i + 1), s.x * CELL + 3, s.y * CELL + 3);
      ctx.fillStyle = is1v1 ? "#f5c542" : "#e2e8f0";
      ctx.fillText(String(i + 1), s.x * CELL + 3, s.y * CELL + 3);
    });

    // 网格线
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x++) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, H * CELL);
    }
    for (let y = 0; y <= H; y++) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(W * CELL, y * CELL + 0.5);
    }
    ctx.stroke();

    // 悬停格 + 镜像伙伴：让"一笔改 4 格"这件事看得见
    if (hover) {
      ctx.strokeStyle = "rgba(122,162,255,0.9)";
      ctx.lineWidth = 2;
      for (const p of mirrorPoints(draft, hover.x, hover.y)) {
        ctx.strokeRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2);
      }
    }
  }, [draft, hover, tick]);

  // ---------------- 指针绘制 ----------------
  const cellFromEvent = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // 画布可能被外层滚动容器缩放（视口小时），按实际显示宽度换算格子尺寸
    const scale = rect.width > 0 ? rect.width / (draft.width * CELL) : 1;
    const x = Math.floor((e.clientX - rect.left) / (CELL * scale));
    const y = Math.floor((e.clientY - rect.top) / (CELL * scale));
    if (x < 0 || y < 0 || x >= draft.width || y >= draft.height) return null;
    return { x, y };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const at = cellFromEvent(e);
    if (!at) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    paintRef.current = { drawing: true, last: `${at.x},${at.y}` };
    commit(paint(draft, brush, at.x, at.y));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const at = cellFromEvent(e);
    setHover(at);
    if (!at || !paintRef.current.drawing) return;
    const key = `${at.x},${at.y}`;
    if (paintRef.current.last === key) return;
    paintRef.current.last = key;
    commit(paint(draft, brush, at.x, at.y));
  };
  const onPointerUp = () => {
    paintRef.current = { drawing: false, last: null };
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") as BrushId;
    const at = cellFromEvent(e);
    if (!at || !id) return;
    setBrush(id);
    commit(paint(draft, id, at.x, at.y));
  };

  // ---------------- 保存 / 试跑 / 导入导出 ----------------
  const save = async () => {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const res = await api.saveMap(map);
      setNotice(`已保存 ${res.mapId}@${map.version}：现在可以被赛事选为赛图，外部 Agent 的上传校验也会覆盖这张图。`);
      loadMaps();
    } catch (err) {
      if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
        const payload = err.payload as { error?: string };
        setError(`保存失败：${payload.error ?? err.message}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const runPlaytest = async () => {
    setError(null);
    setNotice(null);
    setPlaytesting(true);
    setPlaytest(null);
    try {
      const res = await api.playtestMap({ map, seed: 20261019 });
      setPlaytest(res);
    } catch (err) {
      setError(`试跑失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPlaytesting(false);
    }
  };

  const importMap = async (mapId: string) => {
    setError(null);
    try {
      const detail = await api.getMap(mapId);
      const imported = draftFromMap(detail.map);
      // 内置地图 id 保存时会被服务端拒（避免与内置图重名），导入后自动改名
      const next = detail.custom ? imported : setMeta(imported, { mapId: `${imported.mapId}-mine` });
      historyRef.current.push(draft);
      futureRef.current = [];
      setDraft(next);
      syncHistoryFlags();
      setNotice(`已导入 ${mapId}@${detail.map.version} 作为起点${detail.custom ? "" : "（内置图必须换 id 才能另存为自定义图）"}`);
    } catch (err) {
      setError(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const removeCustom = async (mapId: string) => {
    if (!window.confirm(`删除自定义地图 ${mapId}？已用它跑过的比赛记录不受影响。`)) return;
    try {
      await api.deleteMap(mapId);
      loadMaps();
      setNotice(`已删除 ${mapId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const downloadJson = () => {
    const blob = new Blob([draftJson(draft)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${draft.mapId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(draftJson(draft));
      setNotice("地图 JSON 已复制到剪贴板");
    } catch {
      setError("复制失败（浏览器拒绝了剪贴板权限），可以改用「下载 JSON」");
    }
  };

  const nodeRows = useMemo(
    () => draft.facilities.map((f, index) => ({ f, index })).filter((r) => r.f.kind === "resource"),
    [draft.facilities],
  );
  const ammoRows = useMemo(
    () => draft.facilities.map((f, index) => ({ f, index })).filter((r) => r.f.kind === "ammo"),
    [draft.facilities],
  );
  const fuelRows = useMemo(
    () => draft.facilities.map((f, index) => ({ f, index })).filter((r) => r.f.kind === "fuel"),
    [draft.facilities],
  );
  const spawns = spawnsOf(draft);
  const spawnOrdinals = spawns.map((_, i) => i + 1);
  const playtestSpawnOf = (seat: number) => {
    const hit = playtest?.spawns.find((s) => s.seat === seat);
    return hit ? `(${hit.pos.x},${hit.pos.y})` : "-";
  };

  return (
    <div className="stack">
      <Section
        title="地图编辑器"
        extra={
          <div className="form-actions">
            <button className="btn btn-sm" onClick={undo} disabled={historySize === 0} title="Ctrl+Z">
              撤销
            </button>
            <button className="btn btn-sm" onClick={redo} disabled={futureSize === 0} title="Ctrl+Shift+Z">
              重做
            </button>
            <button className="btn btn-sm" onClick={downloadJson}>
              下载 JSON
            </button>
            <button className="btn btn-sm" onClick={() => void copyJson()}>
              复制 JSON
            </button>
          </div>
        }
      >
        <p className="hint">
          从左侧元素盘<strong>拖动</strong>元素到格子上（或点选画笔后在格子上按住拖动连画）。开启镜像锁定时，
          一笔同时作用于 4 个镜像格——平台要求地图横竖镜像对称，因为只有四角等价才能保证座次公平。
          右侧实时给出结构校验与玩法审计；「试跑一局」会让平台基线脚本在这张图上真打一局，验证它是不是"能打起来"。
        </p>
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {error ? <Banner tone="error">{error}</Banner> : null}

        <div className="editor-layout">
          {/* ---------------- 元素盘 ---------------- */}
          <div className="editor-palette">
            {PALETTE.map((group) => (
              <div className="palette-group" key={group.group}>
                <div className="palette-title">{group.group}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={`palette-item ${brush === item.id ? "palette-on" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", item.id);
                      e.dataTransfer.effectAllowed = "copy";
                      setBrush(item.id);
                    }}
                    onClick={() => setBrush(item.id)}
                    title={`${BRUSH_LABEL[item.id]}：${item.hint}（可直接拖到地图上）`}
                  >
                    {BRUSH_ICON[item.id] ? (
                      <img className="palette-icon" src={spriteSrc(BRUSH_ICON[item.id]!)} alt="" draggable={false} />
                    ) : (
                      <span className="palette-erase">⌫</span>
                    )}
                    <span className="palette-label">{BRUSH_LABEL[item.id]}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* ---------------- 画布 ---------------- */}
          <div className="editor-board">
            <div
              className="editor-canvas-wrap"
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={onDrop}
            >
              <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => {
                  onPointerUp();
                  setHover(null);
                }}
              />
            </div>
            <div className="editor-status muted small">
              {hover ? (
                <>
                  光标 <code>({hover.x},{hover.y})</code> · 地形 <code>{terrainAt(draft, hover.x, hover.y)}</code>
                  {facilityAt(draft, hover.x, hover.y)
                    ? <> · 设施 <code>{BRUSH_LABEL[facilityAt(draft, hover.x, hover.y)!.kind]}</code></>
                    : null}
                  {!isWalkable(draft, hover.x, hover.y) ? "（不可通行）" : ""}
                  {draft.mirror === "HV" ? ` · 镜像伙伴 ${mirrorPoints(draft, hover.x, hover.y).length - 1} 个` : ""}
                </>
              ) : (
                <>把鼠标移到格子上查看坐标；当前画笔：{BRUSH_LABEL[brush]}</>
              )}
            </div>
          </div>

          {/* ---------------- 参数面板 ---------------- */}
          <div className="editor-panel">
            <div className="panel-block">
              <div className="palette-title">地图信息</div>
              <label className="field">
                <span>地图 id（保存后就是赛图名）</span>
                <input
                  value={draft.mapId}
                  onChange={(e) => setDraft(setMeta(draft, { mapId: e.target.value.replace(/[^a-z0-9-]/g, "").toLowerCase() }))}
                />
              </label>
              {!idOk ? (
                <div className="muted small">
                  只允许小写字母/数字/连字符（3~32 位，首尾为字母或数字），且不能与内置地图重名。
                </div>
              ) : null}
              <label className="field">
                <span>版本号（改动地形后建议 +1）</span>
                <input
                  type="number"
                  min={1}
                  value={draft.version}
                  onChange={(e) => setDraft(setMeta(draft, { version: Math.max(1, Number(e.target.value) || 1) }))}
                />
              </label>
              <label className="field">
                <span>一句话说明（展示在赛事选图列表与任务书里）</span>
                <input
                  value={draft.hint}
                  placeholder="例如：21×21 双翼图，中央高地争夺"
                  onChange={(e) => setDraft(setMeta(draft, { hint: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>尺寸（宽 × 高，9~48）</span>
                <span className="size-inputs">
                  <input
                    type="number"
                    value={draft.width}
                    onChange={(e) => commit(resizeDraft(draft, Number(e.target.value), draft.height))}
                  />
                  <span className="muted">×</span>
                  <input
                    type="number"
                    value={draft.height}
                    onChange={(e) => commit(resizeDraft(draft, draft.width, Number(e.target.value)))}
                  />
                </span>
              </label>
              <div className="field">
                <span>镜像模式</span>
                <div className="chip-row">
                  <button
                    className={`chip ${draft.mirror === "HV" ? "chip-on" : ""}`}
                    onClick={() => setDraft(setMeta(draft, { mirror: "HV" }))}
                    title="一笔作用于 4 个镜像格，天然满足平台的对称性要求"
                  >
                    镜像锁定（推荐）
                  </button>
                  <button
                    className={`chip ${draft.mirror === "none" ? "chip-on" : ""}`}
                    onClick={() => setDraft(setMeta(draft, { mirror: "none" }))}
                    title="自由绘制；保存前必须自己修成对称，否则校验不通过"
                  >
                    自由绘制
                  </button>
                </div>
              </div>
              <div className="form-actions">
                <button className="btn btn-sm" onClick={() => commit(borderWall(draft, true))}>
                  四周加墙
                </button>
                <button className="btn btn-sm" onClick={() => commit(borderWall(draft, false))}>
                  去掉外框
                </button>
                <button className="btn btn-sm" onClick={() => commit(mirrorize(draft))} title="以左上象限为准镜像出另外三个象限">
                  一键镜像化
                </button>
                <button className="btn btn-sm" onClick={() => commit(clearFacilities(draft))}>
                  清空设施
                </button>
                <button className="btn btn-sm" onClick={() => commit(emptyDraft(draft.width, draft.height, draft.mapId))}>
                  清空地块
                </button>
              </div>
            </div>

            <div className="panel-block">
              <div className="palette-title">导入现成地图作为起点</div>
              <div className="form-actions">
                {allMaps.map((m) => (
                  <button key={m.mapId} className="btn btn-sm" onClick={() => void importMap(m.mapId)} title={m.hint}>
                    导入 {m.mapId}
                    {m.custom ? "（自定义）" : ""}
                  </button>
                ))}
                {allMaps.length === 0 ? <span className="muted small">地图列表不可用（后端未启动？）</span> : null}
              </div>
            </div>

            <div className="panel-block">
              <div className="palette-title">
                校验结果{" "}
                {audit.errors.length === 0 ? (
                  <Badge tone="ok">结构 + 审计通过</Badge>
                ) : (
                  <Badge tone="danger">{audit.errors.length} 项错误</Badge>
                )}
              </div>
              {audit.errors.length > 0 ? (
                <ul className="checklist">
                  {audit.errors.map((e, i) => (
                    <li key={i} className="ck-bad">
                      <span className="ck-mark">⛔</span>
                      <span>{e}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted small">结构自洽、设施可达、出生点等价——可以保存，也可以直接拿去比赛。</div>
              )}
              {audit.warnings.length > 0 ? (
                <>
                  <div className="muted small" style={{ marginTop: 8 }}>建议关注（不阻止保存）：</div>
                  <ul className="checklist">
                    {audit.warnings.map((w, i) => (
                      <li key={i} className="ck-warn">
                        <span className="ck-mark">⚠️</span>
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>

            <div className="panel-block">
              <div className="palette-title">统计</div>
              <div className="kv">
                <span>可通行 {stats.walkable} 格</span>
                <span>墙 {stats.wall}</span>
                <span>水 {stats.water}</span>
                <span>森林 {stats.forest}</span>
              </div>
              <div className="kv">
                <span>出生点 {stats.spawns}</span>
                <span>弹药 {stats.ammo}</span>
                <span>加油 {stats.fuel}</span>
                <span>资源点 {stats.resource}</span>
                <span>提交点 {stats.deposit}</span>
              </div>
              {audit.spawnDistances.length > 0 ? (
                <div className="muted small">出生点两两距离：{audit.spawnDistances.map((d) => (d < 0 ? "不可达" : `${d} 步`)).join(" / ")}</div>
              ) : null}
            </div>

            <div className="panel-block">
              <div className="palette-title">距离参考（实测寻路）</div>
              {Object.keys(audit.distances).length === 0 ? (
                <div className="muted small">还需要出生点与设施才能算出距离。</div>
              ) : (
                <ul className="checklist">
                  {Object.entries(audit.distances).map(([k, v]) => (
                    <li key={k} className="ck-ok">
                      <span className="ck-mark">·</span>
                      <span>{DISTANCE_LABELS[k] ?? k}：{v} 步</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </Section>

      <Section title="出生点" extra={<span className="muted small">序号 = 脚本里 MAP.spawns 的顺序；金框两个是 1v1 用点</span>}>
        {spawns.length === 0 ? (
          <div className="hint">还没有出生点。用元素盘里的「出生点」往地图上拖（镜像锁定会一次放 4 个）。</div>
        ) : (
          <>
            <div className="config-grid">
              <label className="field">
                <span>1v1 先手点（序号）</span>
                <select
                  value={draft.spawnsFor1v1[0]}
                  onChange={(e) => commit(setSpawn1v1Slot(draft, 0, Number(e.target.value)))}
                  disabled={spawns.length < 2}
                >
                  {spawnOrdinals.map((i) => (
                    <option key={i} value={i}>
                      #{i} (${spawns[i - 1]!.x},${spawns[i - 1]!.y})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>1v1 后手点（序号）</span>
                <select
                  value={draft.spawnsFor1v1[1]}
                  onChange={(e) => commit(setSpawn1v1Slot(draft, 1, Number(e.target.value)))}
                  disabled={spawns.length < 2}
                >
                  {spawnOrdinals.map((i) => (
                    <option key={i} value={i}>
                      #{i} (${spawns[i - 1]!.x},${spawns[i - 1]!.y})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>坐标</th>
                  <th>1v1</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {spawns.map((s, i) => {
                  const ord = i + 1;
                  const isPair = draft.spawnsFor1v1[0] === ord || draft.spawnsFor1v1[1] === ord;
                  return (
                    <tr key={`${s.x},${s.y}`}>
                      <td>#{ord}</td>
                      <td className="mono">
                        ({s.x},{s.y})
                      </td>
                      <td>{isPair ? <Badge tone="warn">1v1 用点</Badge> : <span className="muted">—</span>}</td>
                      <td>
                        <button className="btn btn-sm" onClick={() => commit(eraseAt(draft, s.x, s.y))}>
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section
        title="车辆参数"
        extra={<span className="muted small">不勾 = 整张图跟随 RULES（{DEFAULT_RULESET.hpMax} 血 / {DEFAULT_RULESET.ammoMax} 弹 / {DEFAULT_RULESET.cargoMax} 货）</span>}
      >
        <label className="chip-toggle">
          <input
            type="checkbox"
            checked={draft.tuning !== null}
            onChange={(e) => commit(setTuning(draft, e.target.checked ? {} : null))}
          />
          用地图自己的车辆参数（覆盖规则里的上限）
        </label>
        {draft.tuning ? (
          <div className="config-grid" style={{ marginTop: 10 }}>
            <label className="field">
              <span>最大血量</span>
              <input
                type="number"
                min={1}
                value={draft.tuning.hpMax ?? DEFAULT_TUNING.hpMax}
                onChange={(e) => commit(setTuning(draft, { hpMax: Math.max(1, Math.round(Number(e.target.value) || 1)) }))}
              />
            </label>
            <label className="field">
              <span>最大载弹量（0 = 禁止相互攻击）</span>
              <input
                type="number"
                min={0}
                value={draft.tuning.ammoMax ?? DEFAULT_TUNING.ammoMax}
                onChange={(e) => commit(setTuning(draft, { ammoMax: Math.max(0, Math.round(Number(e.target.value) || 0)) }))}
              />
            </label>
            <label className="field">
              <span>最大载货（0 = 采了也装不下）</span>
              <input
                type="number"
                min={0}
                value={draft.tuning.cargoMax ?? DEFAULT_TUNING.cargoMax}
                onChange={(e) => commit(setTuning(draft, { cargoMax: Math.max(0, Math.round(Number(e.target.value) || 0)) }))}
              />
            </label>
          </div>
        ) : null}
        <p className="hint">
          上限调低时，出门与复活的补给会自动夹到上限之内（载弹上限 0 的图，坦克出门就没有炮弹，只在采集与提交上比高低）。
          脚本一律读 <code>state.self.hpMax / ammoMax / cargoMax</code>，不要假设它们等于规则默认值。
        </p>
      </Section>

      <Section
        title="弹药点库存"
        extra={<span className="muted small">留空 = 无限供给；写了容量就是"拿空 + 每 N 轮回 1"</span>}
      >
        <SupplyParams
          label="弹药补给点"
          kind="ammo"
          rows={ammoRows}
          perVisit={DEFAULT_RULESET.loadAmmoPerAction}
          draft={draft}
          onPatch={(index, patch) => commit(setSupplyParams(draft, index, patch))}
          onRemove={(x, y) => commit(eraseAt(draft, x, y))}
        />
      </Section>

      <Section
        title="加油点库存"
        extra={<span className="muted small">同弹药点：留空 = 无限供给</span>}
      >
        <SupplyParams
          label="加油点"
          kind="fuel"
          rows={fuelRows}
          perVisit={DEFAULT_RULESET.refuelPerAction}
          draft={draft}
          onPatch={(index, patch) => commit(setSupplyParams(draft, index, patch))}
          onRemove={(x, y) => commit(eraseAt(draft, x, y))}
        />
      </Section>

      <Section title="资源点参数" extra={<span className="muted small">产出 = 容量 ÷ 回复间隔（单位/轮）</span>}>
        {nodeRows.length === 0 ? (
          <div className="hint">还没有资源点。资源点是这张图的收入来源，没有它双方只能互相干瞪眼。</div>
        ) : (
          <table className="table table-dense">
            <thead>
              <tr>
                <th>id</th>
                <th>坐标</th>
                <th>类型</th>
                <th>容量</th>
                <th>初始量</th>
                <th>每 N 轮 +1</th>
                <th>产出</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {nodeRows.map(({ f, index }, i) => (
                <tr key={`${f.x},${f.y}`}>
                  <td className="mono">R{i + 1}</td>
                  <td className="mono">
                    ({f.x},{f.y})
                  </td>
                  <td>
                    <select
                      value={f.nodeKind ?? "center"}
                      onChange={(e) => commit(setNodeParams(draft, index, { nodeKind: e.target.value as "home" | "center" }))}
                    >
                      <option value="home">home（前哨，稳但产出低）</option>
                      <option value="center">center（中央，高产但要抢）</option>
                    </select>
                  </td>
                  {(["capacity", "initial", "regenEveryRounds"] as const).map((key) => (
                    <td key={key}>
                      <input
                        type="number"
                        min={1}
                        style={{ width: 70 }}
                        value={f[key] ?? (key === "capacity" ? 10 : key === "initial" ? 10 : 4)}
                        onChange={(e) => commit(setNodeParams(draft, index, { [key]: Math.max(1, Number(e.target.value) || 1) }))}
                      />
                    </td>
                  ))}
                  <td className="mono small">{((f.capacity ?? 10) / Math.max(1, f.regenEveryRounds ?? 4)).toFixed(2)}/轮</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => commit(eraseAt(draft, f.x, f.y))}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title="保存与试跑"
        extra={
          <div className="form-actions">
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !canSave}>
              {saving ? "保存中…" : canSave ? "保存到服务端" : "先修掉校验错误"}
            </button>
            <button className="btn" onClick={() => void runPlaytest()} disabled={playtesting || audit.errors.length > 0}>
              {playtesting ? "试跑中…" : "试跑一局（基线 vs 基线）"}
            </button>
          </div>
        }
      >
        <p className="hint">
          保存后这张图进入地图注册表：赛事可以选它当赛图，外部 Agent 的上传校验也会覆盖它
          （所以"多了一张自定义图"不会让已经入库的脚本突然跑不动）。试跑不需要先保存，直接用当前草稿开一局。
        </p>
        {playtest ? (
          <>
            <div className="kv">
              <span>{playtest.ok ? "✅ 能打起来" : "❌ 有问题"}</span>
              <span>轮次 {playtest.combat.turns}</span>
              <span>开火 {playtest.combat.fires} / 命中 {playtest.combat.hits}</span>
              <span>击杀 {playtest.combat.kills}</span>
              <span>首次交火第 {playtest.combat.firstFireRound ?? "-"} 轮</span>
              <span>提交 {playtest.economy.unitsDeposited} 单位</span>
              <span>无效动作 {playtest.economy.invalidActions} / strike {playtest.economy.strikes}</span>
            </div>
            <ul className="checklist">
              {playtest.verdicts.map((v, i) => (
                <li key={i} className={v.startsWith("✅") ? "ck-ok" : v.startsWith("❌") ? "ck-bad" : "ck-warn"}>
                  <span className="ck-mark">·</span>
                  <span>{v}</span>
                </li>
              ))}
            </ul>
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>座位</th>
                  <th>出生点</th>
                  <th>脚本</th>
                  <th>分数</th>
                  <th>提交</th>
                  <th>击杀</th>
                  <th>死亡</th>
                  <th>开火/命中</th>
                  <th>平均决策</th>
                </tr>
              </thead>
              <tbody>
                {playtest.ranking.map((r) => (
                  <tr key={r.seat}>
                    <td>P{r.seat}</td>
                    <td className="mono">{playtestSpawnOf(r.seat)}</td>
                    <td>{r.name}</td>
                    <td className="mono">{r.score}</td>
                    <td>{r.unitsDeposited}</td>
                    <td>{r.kills}</td>
                    <td>{r.deaths}</td>
                    <td>
                      {r.shotsFired} / {r.hits}
                    </td>
                    <td>{Math.round(r.avgDecisionMs)}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <div className="muted small">
            还没有试跑结果。基线脚本是平台自带的参考实现，双方都是它时打出来的就是"这张图的默认节奏"。
          </div>
        )}
      </Section>

      <Section title="服务端上的自定义地图" extra={<span className="muted small">共 {customMaps.length} 张</span>}>
        {customMaps.length === 0 ? (
          <EmptyState
            title="还没有保存过自定义地图"
            hint="做好一张点上面的「保存到服务端」，它就会出现在这里，并且能在「赛事」页被选为赛图。"
          />
        ) : (
          <table className="table table-dense">
            <thead>
              <tr>
                <th>地图</th>
                <th>尺寸</th>
                <th>说明</th>
                <th>审计</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {customMaps.map((m) => (
                <tr key={m.mapId}>
                  <td className="mono">
                    {m.mapId}@{m.version}
                  </td>
                  <td>
                    {m.width}×{m.height}
                  </td>
                  <td className="small">{m.hint || <span className="muted">—</span>}</td>
                  <td>
                    {m.errorCount ? <Badge tone="danger">{m.errorCount} 错误</Badge> : <Badge tone="ok">通过</Badge>}
                    {m.warningCount ? <Badge tone="warn">{m.warningCount} 提示</Badge> : null}
                  </td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => void importMap(m.mapId)}>
                      载入编辑
                    </button>
                    <button className="btn btn-sm" onClick={() => void removeCustom(m.mapId)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

/**
 * 补给点（弹药点/加油点）参数表：容量留空 = 无限供给（平台历史行为），写了就"拿空 + 按间隔回充"。
 * 放在组件外面定义：不然父组件每敲一个数字都会重建组件、输入框会掉焦点。
 */
function SupplyParams({
  label,
  kind,
  rows,
  perVisit,
  draft,
  onPatch,
  onRemove,
}: {
  label: string;
  kind: FacilityKind;
  rows: { f: DraftFacilityRow; index: number }[];
  perVisit: number;
  draft: MapDraft;
  onPatch: (index: number, patch: Partial<DraftFacilityRow>) => void;
  onRemove: (x: number, y: number) => void;
}) {
  if (rows.length === 0) {
    return <div className="hint">还没有{label}。用元素盘里的「{label}」往地图上拖（镜像锁定会一次放 4 个）。</div>;
  }
  return (
    <table className="table table-dense">
      <thead>
        <tr>
          <th>坐标</th>
          <th>容量（留空 = 无限）</th>
          <th>初始库存</th>
          <th>每 N 轮 +1</th>
          <th>一次补给</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ f, index }, i) => {
          const capacity = f.capacity;
          const perRound = capacity === undefined ? "无限" : `${(1 / Math.max(1, f.regenEveryRounds ?? 4)).toFixed(2)}/轮`;
          return (
            <tr key={`${kind}-${f.x},${f.y}-${i}`}>
              <td className="mono">
                ({f.x},{f.y})
              </td>
              <td>
                <input
                  type="number"
                  min={1}
                  style={{ width: 90 }}
                  placeholder="无限"
                  value={capacity ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    // 清空输入框 = 回到无限供给（连同初始量与刷新间隔一起丢掉）
                    if (raw === "") return onPatch(index, { capacity: undefined, initial: undefined, regenEveryRounds: undefined });
                    const n = Math.max(1, Math.round(Number(raw) || 1));
                    onPatch(index, { capacity: n, initial: Math.min(f.initial ?? n, n), regenEveryRounds: f.regenEveryRounds ?? 4 });
                  }}
                />
              </td>
              {(["initial", "regenEveryRounds"] as const).map((key) => (
                <td key={key}>
                  <input
                    type="number"
                    min={key === "initial" ? 0 : 1}
                    style={{ width: 70 }}
                    disabled={capacity === undefined}
                    value={capacity === undefined ? "" : (f[key] ?? (key === "initial" ? capacity : 4))}
                    onChange={(e) => onPatch(index, { [key]: Math.max(key === "initial" ? 0 : 1, Math.round(Number(e.target.value) || 0)) })}
                  />
                </td>
              ))}
              <td className="mono small">
                {capacity === undefined ? "点上有分就能一直补给" : `${perRound} · 一次最多 ${Math.min(perVisit, capacity)}`}
              </td>
              <td>
                <button className="btn btn-sm" onClick={() => onRemove(f.x, f.y)}>
                  删除
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 补给点行的形状（与 mapDraft 的 DraftFacility 一致，这里只用到这几个字段） */
type DraftFacilityRow = { kind: FacilityKind; x: number; y: number; capacity?: number; initial?: number; regenEveryRounds?: number };