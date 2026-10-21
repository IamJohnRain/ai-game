// apps/web/src/useCommentary.ts —— 解说稿的前端状态：取稿、生成、轮询、删除
//
// 为什么放在 hook 里：观战页与回放页都要用同一套逻辑（同一场比赛的稿子只有一份），
// 生成是后端排队的异步任务，前端只需要"发起 + 轮询到出结果"，轮询窗口与停止条件都在这。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type CommentaryState } from "./api";

const POLL_MS = 2500;
const POLL_LIMIT = 96; // ≈4 分钟：足够 6 次调用跑完，超了就停下让用户自己重试

export interface CommentaryHook {
  state: CommentaryState | null;
  /** 正在发起/正在轮询（与后端 status=generating 是两回事：这个是"前端在等"） */
  busy: boolean;
  error: string | null;
  generate: (force?: boolean) => Promise<void>;
  remove: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useCommentary(matchId: string | null): CommentaryHook {
  const [state, setState] = useState<CommentaryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const pollsRef = useRef(0);
  const aliveRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pollsRef.current = 0;
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const load = useCallback(async (id: string): Promise<CommentaryState | null> => {
    try {
      const next = await api.matchCommentary(id);
      if (aliveRef.current) setState(next);
      return next;
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  const poll = useCallback(
    (id: string) => {
      const tick = async () => {
        pollsRef.current += 1;
        const next = await load(id);
        if (!aliveRef.current) return;
        if (!next || next.status !== "generating" || pollsRef.current >= POLL_LIMIT) {
          setBusy(false);
          stopPolling();
          if (next && next.status === "generating") {
            setError("等了很久还没出稿子：可以在解说设置里把超时调小，或点“重新生成”");
          }
          return;
        }
        timerRef.current = window.setTimeout(tick, POLL_MS);
      };
      timerRef.current = window.setTimeout(tick, 800);
    },
    [load, stopPolling],
  );

  // 换比赛：清空旧稿子并按需拉一次
  const idRef = useRef<string | null>(null);
  useEffect(() => {
    idRef.current = matchId;
    stopPolling();
    setBusy(false);
    setError(null);
    setState(null);
    if (!matchId) return;
    void (async () => {
      const next = await load(matchId);
      if (next?.status === "generating") {
        setBusy(true);
        poll(matchId);
      }
    })();
  }, [matchId, load, poll, stopPolling]);

  const generate = useCallback(
    async (force = false) => {
      const id = idRef.current;
      if (!id) return;
      setBusy(true);
      setError(null);
      try {
        const res = await api.generateCommentary(id, force);
        if (!aliveRef.current) return;
        if (!res.queued && res.segments) {
          // 后端说"不用排队"（已有稿子）时直接落位
          await load(id);
          setBusy(false);
          return;
        }
        if (!res.queued) setError(res.reason ?? "没有开始生成");
        poll(id);
      } catch (err) {
        if (!aliveRef.current) return;
        setBusy(false);
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
      }
    },
    [load, poll],
  );

  const remove = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    stopPolling();
    setBusy(true);
    try {
      await api.deleteCommentary(id);
      if (aliveRef.current) {
        setState({ status: "none", segments: [], modelId: "", baseUrl: "", usage: null, error: null, createdAt: null, finishedAt: null, configured: true });
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [stopPolling]);

  return { state, busy, error, generate, remove, reload: useCallback(async () => { if (idRef.current) await load(idRef.current); }, [load]) };
}