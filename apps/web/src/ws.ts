// apps/web/src/ws.ts —— 观战 WebSocket 封装：断线自动重连 + 消息类型守卫
// 为什么需要它：比赛可能持续几分钟，刷新页面/网络抖动后必须能接着看。
// 服务端在每次连接建立时先推一条 snapshot（含全量事件），所以"重连=重放恢复"，
// 客户端不需要自己做断点续传。
import type { WsMessage } from "./api";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface MatchSocketHandlers {
  onMessage(msg: WsMessage): void;
  onStatus(status: ConnectionStatus, detail?: string): void;
  /** 连接层错误（不影响重连逻辑） */
  onError?(message: string): void;
}

export interface MatchSocket {
  close(): void;
}

const KNOWN_TYPES = new Set(["snapshot", "phase", "event", "scores", "end"]);
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;

function isWsMessage(value: unknown): value is WsMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && KNOWN_TYPES.has(type);
}

export function matchSocketUrl(matchId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/matches/${encodeURIComponent(matchId)}`;
}

export function openMatchSocket(matchId: string, handlers: MatchSocketHandlers): MatchSocket {
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let retryDelay = RETRY_MIN_MS;
  let closed = false;

  const scheduleRetry = () => {
    if (closed || retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryDelay);
    // 指数退避，避免后端重启期间刷爆日志
    retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
  };

  const connect = () => {
    if (closed) return;
    handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(matchSocketUrl(matchId));
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err.message : String(err));
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      retryDelay = RETRY_MIN_MS;
      handlers.onStatus("connected");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // 契约只推 JSON 文本
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        handlers.onError?.("收到无法解析的消息（非 JSON），已忽略");
        return;
      }
      if (!isWsMessage(parsed)) {
        handlers.onError?.("收到未知类型的消息，已忽略");
        return;
      }
      handlers.onMessage(parsed);
    };
    ws.onerror = () => {
      // onerror 之后一定会有 onclose，重连交给 onclose，避免重复排程
      handlers.onError?.("WebSocket 连接错误");
    };
    ws.onclose = (ev) => {
      socket = null;
      handlers.onStatus("disconnected", ev.reason || undefined);
      scheduleRetry();
    };
  };

  connect();

  return {
    close() {
      closed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (socket) {
        const ws = socket;
        socket = null;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
      handlers.onStatus("disconnected", "已主动断开");
    },
  };
}