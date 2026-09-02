import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Clock, ListTodo, Square, X, XCircle } from "lucide-react";
import { api, wsClient, type Job } from "../api";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";

const TYPE_LABEL: Record<Job["type"], string> = {
  extract_frames: "job.extract",
  generate_frames: "msg.generate",
  matting: "msg.matting",
  image_layers: "layers.action",
};

const DONE_TTL = 6000; // 完成/取消任务停留 6s 后自动移除
const MAX_ITEMS = 20;
const POS_KEY = "framebaker-jobpanel-pos";
const PANEL_W = 264;
const NAV_H = 60; // 顶部导航栏高度，拖拽下限需避开以免头部被遮挡无法抓取

const isActive = (j: Job) => j.status === "queued" || j.status === "running";
const isTransient = (j: Job) => j.status === "done" || j.status === "cancelled";

/** 单条任务行 —— memo：仅当本条 job 变化时才重渲染，避免每次进度心跳全量 reconcile */
const JobItem = memo(function JobItem({
  job,
  cancelling,
  onCancel,
  onDismiss,
}: {
  job: Job;
  cancelling: boolean;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const t = useT();
  return (
    <motion.div
      className={`job-item ${job.status}`}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
    >
      <div className="row">
        {job.status === "done" ? (
          <CheckCircle2 size={13} className="ok" />
        ) : job.status === "error" ? (
          <XCircle size={13} className="err" />
        ) : job.status === "cancelled" ? (
          <Square size={13} className="wait" />
        ) : (
          <Clock size={13} className="wait" />
        )}
        <span className="kind">{t(TYPE_LABEL[job.type] ?? job.type)}</span>
        <span className="prog" title={job.error ?? job.progress ?? undefined}>
          {job.status === "done"
            ? (job.progress && job.progress !== "完成" ? job.progress : t("msg.done"))
            : job.status === "error"
              ? t("msg.failed")
              : job.status === "cancelled"
                ? t("msg.cancelled")
                : (job.progress ?? (job.status === "queued" ? t("msg.queued") : t("msg.processing")))}
        </span>
        {isActive(job) && (
          <button
            type="button"
            className="dismiss"
            title={t("msg.cancel_job")}
            disabled={cancelling}
            onClick={() => onCancel(job.id)}
          >
            <Square size={11} />
          </button>
        )}
        {(job.status === "done" || job.status === "error" || job.status === "cancelled") && (
          <button type="button" className="dismiss" title={t("msg.dismiss")} onClick={() => onDismiss(job.id)}>
            <X size={12} />
          </button>
        )}
      </div>
      <div
        className={`px-progress ${job.status === "done" ? "done" : ""} ${job.status === "error" ? "error" : ""} ${job.status === "cancelled" ? "error" : ""}`}
      >
        <div className="bar" />
      </div>
      {job.status === "error" && job.error && <div className="job-error-text">{job.error}</div>}
    </motion.div>
  );
});

/**
 * 右侧常驻任务队列面板：初始接管进行中的任务，之后靠 WS job_* 事件驱动（3s 批量轮询兜底断连恢复期）。
 * 进入素材库时重新拉取任务列表，对齐离开期间可能漏掉的任务状态。
 * 完成/取消短暂停留后消失；失败常驻可手动关闭。排队/运行中可取消。
 *
 * 性能：state 为 Record<id, Job>，WS 事件按 payload 局部 patch（不再为每条事件多发一次 GET）；
 * 行渲染走 memo 化 JobItem，未变化的行跳过 reconcile。
 */
export default function JobPanel({ syncOnEnter = false }: { syncOnEnter?: boolean }) {
  const t = useT();
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, number>());
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const cancellingRef = useRef(cancelling);
  cancellingRef.current = cancelling;

  // —— 拖拽移动面板 ——
  // pos 为 null 时沿用 CSS 默认（右上角）；拖拽后存 left/top 并持久化
  const [pos, setPos] = useState<{ left: number; top: number } | null>(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.left === "number" && typeof p.top === "number") {
          // 修正历史存档中 top 过低被导航栏遮挡的情况
          return { left: p.left, top: Math.max(NAV_H, p.top) };
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    // 只响应主键，且不拦截头部内按钮的点击
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const left = d.ox + (e.clientX - d.sx);
      const top = d.oy + (e.clientY - d.sy);
      const maxX = window.innerWidth - PANEL_W;
      const maxY = window.innerHeight - 40; // 至少留头部可见
      setPos({
        left: Math.max(0, Math.min(left, maxX)),
        top: Math.max(NAV_H, Math.min(top, maxY)),
      });
    };
    const onUp = () => {
      drag.current = null;
      setDragging(false);
      setPos((cur) => {
        if (cur) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify(cur));
          } catch {
            /* ignore */
          }
        }
        return cur;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  /** 安排完成/取消行的自动消失计时 */
  const scheduleDismiss = useCallback((id: string) => {
    if (timers.current.has(id)) return;
    timers.current.set(
      id,
      window.setTimeout(() => {
        timers.current.delete(id);
        setJobs((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, DONE_TTL)
    );
  }, []);

  /** 写入/覆盖单条 job（来自初始加载、轮询、job_queued） */
  const upsertJob = useCallback(
    (job: Job) => {
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      if (isTransient(job)) scheduleDismiss(job.id);
    },
    [scheduleDismiss]
  );

  /** 局部 patch 单条 job（来自 WS 进度/状态事件）；未知 id 主动拉取，覆盖初始加载与 WS 的竞态 */
  const patchJob = useCallback((id: string, patch: Partial<Job>) => {
    if (!jobsRef.current[id]) {
      void api.getJob(id).then(upsertJob).catch(() => {});
      return;
    }
    setJobs((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, ...patch } };
    });
    if (patch.status && isTransient({ ...({} as Job), status: patch.status })) scheduleDismiss(id);
  }, [scheduleDismiss, upsertJob]);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setJobs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const cancel = useCallback(
    async (id: string) => {
      if (cancellingRef.current.has(id)) return;
      if (!(await askConfirm(t("msg.cancel_this_job_running_commands_will_be_aborted")))) return;
      setCancelling((prev) => new Set(prev).add(id));
      try {
        await api.cancelJob(id);
        // cancel 后 fetch 确认最终态（取消是异步 abort，需等服务端落库）
        const job = await api.getJob(id);
        upsertJob(job);
      } catch (e) {
        notify(t("msg.cancel_failed_msg", { msg: (e as Error).message }));
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [t, upsertJob]
  );

  /** 与服务端任务列表对账：刷新已展示任务，并接管期间漏掉的进行中任务 */
  const syncJobs = useCallback(async () => {
    const before = jobsRef.current;
    const list = await api.listJobs();
    const active = list.filter(isActive).slice(0, MAX_ITEMS);
    setJobs((prev) => {
      const next = { ...prev };
      for (const job of list) {
        // 请求期间若 WS 已更新该任务，以较新的实时状态为准。
        if (next[job.id] && prev[job.id] === before[job.id]) next[job.id] = job;
      }
      for (const job of active) {
        if (!next[job.id]) next[job.id] = job;
      }
      return next;
    });
    for (const job of list) {
      if (isTransient(job)) scheduleDismiss(job.id);
    }
  }, [scheduleDismiss]);

  // 应用启动时接管一次；之后每次从其他页面进入素材库都重新对账。
  const didInitialSync = useRef(false);
  useEffect(() => {
    if (didInitialSync.current && !syncOnEnter) return;
    didInitialSync.current = true;
    void syncJobs().catch(() => {});
  }, [syncJobs, syncOnEnter]);

  // WS 主驱动（直接用 payload 局部 patch，不再每条事件多发一次 GET）
  useEffect(() => {
    const unsub = wsClient.subscribe((msg) => {
      if (!msg.type.startsWith("job_")) return;
      const p = (msg.payload ?? {}) as Record<string, unknown>;
      const id = p.id as string | undefined;
      if (!id) return;
      switch (msg.type) {
        case "job_queued":
          upsertJob({
            id,
            project_id: (p.projectId as string) ?? "",
            type: (p.type as Job["type"]) ?? "matting",
            status: "queued",
            progress: null,
            error: null,
            created_at: Date.now(),
          });
          break;
        case "job_running":
          patchJob(id, { status: "running", progress: "开始处理" });
          break;
        case "job_progress":
          patchJob(id, { progress: (p.progress as string) ?? null });
          break;
        case "job_done":
          patchJob(id, { status: "done", progress: (p.progress as string) ?? "完成", error: null });
          break;
        case "job_error":
          patchJob(id, { status: "error", error: (p.error as string) ?? null });
          break;
        case "job_cancelled":
          patchJob(id, { status: "cancelled", progress: "已取消" });
          break;
      }
    });
    const timerMap = timers.current;
    return () => {
      unsub();
      timerMap.forEach((timer) => clearTimeout(timer));
    };
  }, [patchJob, upsertJob]);

  // 3s 批量轮询兜底（断连恢复期补齐）：跟踪当前 active id，并接收其最终状态
  const activeKey = Object.values(jobs)
    .filter(isActive)
    .map((j) => j.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!activeKey) return;
    const timer = window.setInterval(() => {
      api
        .listJobs()
        .then((list) => {
          const activeIds = new Set(activeKey.split(","));
          const updates = list.filter((job) => activeIds.has(job.id));
          for (const job of updates) {
            if (isTransient(job)) scheduleDismiss(job.id);
          }
          setJobs((prev) => {
            const next: Record<string, Job> = { ...prev };
            for (const j of updates) {
              next[j.id] = j;
            }
            return next;
          });
        })
        .catch(() => {
          /* 断连等，忽略；下个 tick 重试 */
        });
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, scheduleDismiss]);

  // 渲染顺序：进行中前置 → 其余按创建时间倒序；截断 MAX_ITEMS
  const ordered = Object.values(jobs)
    .sort((a, b) => {
      const ai = isActive(a) ? 0 : 1;
      const bi = isActive(b) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return b.created_at - a.created_at;
    })
    .slice(0, MAX_ITEMS);

  if (ordered.length === 0) return null;
  const activeCount = ordered.filter(isActive).length;

  return (
    <div
      ref={panelRef}
      className="job-panel pixel-panel"
      style={
        pos
          ? { left: pos.left, top: pos.top, right: "auto" }
          : undefined
      }
    >
      <div
        className="job-panel-head"
        onPointerDown={onPointerDown}
        style={{ cursor: dragging ? "grabbing" : "grab" }}
      >
        <ListTodo size={13} />
        <span>{t("msg.job_queue")}</span>
        <span className="count">
          {activeCount > 0 ? t("msg.n_running", { n: activeCount }) : t("msg.all_done")}
        </span>
      </div>
      <AnimatePresence initial={false}>
        {ordered.map((j) => (
          <JobItem
            key={j.id}
            job={j}
            cancelling={cancelling.has(j.id)}
            onCancel={cancel}
            onDismiss={dismiss}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
