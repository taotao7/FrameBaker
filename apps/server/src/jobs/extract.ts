import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXTRACT_TIMESTAMPS_MAX, type GenerationIntent } from "@framebaker/shared";
import { db, nextFrameIdx, STORAGE_ROOT, uid } from "../db";
import { createProviderAdapter } from "../providerAdapter";
import { broadcast } from "../ws";
import { JobCancelledError, runCmd } from "./run";
import { createGeneratedArtifactCommitter, type ArtifactCommitResult } from "./generatedArtifacts";
import { appendFramePool } from "../timeline";
import { invalidateProjectUndo } from "../undo";
import { findImageMagick } from "../media";

/** 任务产出目标：项目帧 or 素材库 */
type JobTarget = { kind: "project"; projectId: string } | { kind: "materials" };

export { EXTRACT_TIMESTAMPS_MAX };

export interface ExtractPayload {
  stagingFile: string;
  mediaType: "gif" | "mp4" | "image";
  /** fps 模式（默认）：整段按帧率抽；timestamps 模式忽略 */
  fps: number;
  /** 缺省 fps；timestamps = 按秒列表定点抽（仅 mp4） */
  mode?: "fps" | "timestamps";
  /** 秒（浮点）；mode=timestamps 时必填，服务端排序去重，最多 EXTRACT_TIMESTAMPS_MAX */
  timestamps?: number[];
  autoMatting: boolean;
  target: JobTarget;
  /** 原始文件名（去扩展名），仅 materials 目标用于素材命名 */
  originName?: string;
  /** 素材入库目标文件夹（NULL = 根目录） */
  folderId?: string | null;
}

/** 规范化时间戳：非负、排序、按 1ms 去重、截断上限 */
export function normalizeExtractTimestamps(raw: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const t of [...raw].sort((a, b) => a - b)) {
    if (!Number.isFinite(t) || t < 0) continue;
    const key = Math.round(t * 1000);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key / 1000);
    if (out.length >= EXTRACT_TIMESTAMPS_MAX) break;
  }
  return out;
}

export interface GeneratePayload {
  prompt: string;
  count: number;
  /** 拆分生成任务所属批次的总数；未拆分的旧负载回退到 count。 */
  batchCount?: number;
  /** 当前任务在拆分批次中的零基索引。 */
  batchIndex?: number;
  autoMatting: boolean;
  target: JobTarget;
  /** 素材命名基准（仅 materials 目标；缺省取 prompt 前 24 字符） */
  name?: string;
  /** 引用图绝对路径（服务端按 id 解析，防注入，顺序与请求一致） */
  referencePaths?: string[];
  /** 生成前临时把引用图透明区域铺为纯色；不修改源素材。 */
  flattenBackground?: string;
  /** 生成时选择的 provider id（缺省用第一个已配置 provider） */
  providerId?: string;
  /** 生成时单独指定的模型（api 必填其一；cli 填 {model} 占位符） */
  model?: string;
  /** 生成时选择的尺寸（api 系覆盖 provider 的 apiSize；cli 无尺寸概念忽略） */
  size?: string;
  /** 视频模式：只生成并保存视频素材，不抽帧（抽帧走 POST /api/materials/:id/extract） */
  mediaKind?: "image" | "video";
  /** @deprecated 视频模式不再抽帧；保留字段兼容旧客户端，忽略 */
  fps?: number;
  /** 素材入库目标文件夹（NULL = 根目录） */
  folderId?: string | null;
  /** 上层工作流意图；provider adapter 不消费此字段。 */
  intent?: GenerationIntent;
  /** 骨骼角色生成链关联的角色部件集。 */
  characterPartSetId?: string;
  /** 引用素材 id，仅用于产物谱系 metadata；实际执行只使用服务端解析后的 referencePaths。 */
  referenceMaterialId?: string;
  /** 骨骼分件表网格；默认人形为 3 行 × 4 列。 */
  gridRows?: number;
  gridCols?: number;
  /** 第一阶段完整角色成功后，由调度层创建的第二阶段生成任务。 */
  followUp?: { prompt: string; name?: string; autoMatting?: boolean; gridRows?: number; gridCols?: number };
}

export function buildGeneratedFollowUp(source: GeneratePayload, referenceMaterialId: string, referencePath: string): GeneratePayload | null {
  if (source.intent !== "skeletal-character" || !source.followUp || source.target.kind !== "materials") return null;
  return {
    ...source,
    prompt: source.followUp.prompt,
    name: source.followUp.name,
    count: 1,
    autoMatting: source.followUp.autoMatting ?? source.autoMatting,
    mediaKind: "image",
    referenceMaterialId,
    referencePaths: [referencePath],
    gridRows: source.followUp.gridRows,
    gridCols: source.followUp.gridCols,
    intent: "skeletal-decompose",
    followUp: undefined,
  };
}

type EnqueueMatting = (projectId: string, target: "frame" | "material", id: string) => void;

/** 计算 raw 目录下一个可用的 frame_XXXX 起始编号，避免覆盖已有帧 */
function nextFrameNumber(rawDir: string): number {
  let start = 0;
  for (const f of readdirSync(rawDir)) {
    const m = /^frame_(\d+)\.png$/.exec(f);
    if (m) start = Math.max(start, parseInt(m[1], 10) + 1);
  }
  return start;
}

function afterImportFrames(
  projectId: string,
  frameIds: string[],
  autoMatting: boolean,
  enqueueMatting: EnqueueMatting
) {
  broadcast("frames_changed", { projectId });
  if (autoMatting) {
    for (const frameId of frameIds) {
      enqueueMatting(projectId, "frame", frameId);
    }
  }
}

function afterImportMaterials(materialIds: string[], autoMatting: boolean, enqueueMatting: EnqueueMatting) {
  broadcast("materials_changed", {});
  if (autoMatting) {
    for (const id of materialIds) {
      enqueueMatting("", "material", id);
    }
  }
}

/** 拆帧到独立暂存目录（两种目标共用），返回排序后的文件名列表 */
async function extractToStaging(
  p: ExtractPayload,
  progress: (s: string) => void,
  signal?: AbortSignal
): Promise<{ stageDir: string; files: string[] }> {
  if (signal?.aborted) throw new JobCancelledError();
  // 先拆到独立暂存目录，再按目标统一处理
  const stageDir = join(STORAGE_ROOT, "staging", `extract_${uid()}`);
  mkdirSync(stageDir, { recursive: true });
  const outPattern = `${stageDir}/frame_%04d.png`;

  progress("拆帧中");
  if (p.mediaType === "image") {
    copyFileSync(p.stagingFile, `${stageDir}/frame_0000.png`);
  } else if (p.mediaType === "gif") {
    await runCmd(["ffmpeg", "-y", "-i", p.stagingFile, "-start_number", "0", outPattern], undefined, signal);
  } else if (p.mode === "timestamps") {
    const times = normalizeExtractTimestamps(p.timestamps ?? []);
    if (times.length === 0) throw new Error("未提供有效抽帧时间点");
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw new JobCancelledError();
      progress(`截帧 ${i + 1}/${times.length}`);
      const out = `${stageDir}/frame_${String(i).padStart(4, "0")}.png`;
      // -ss 在 -i 前：按关键帧快进，单帧输出
      await runCmd(
        ["ffmpeg", "-y", "-ss", String(times[i]), "-i", p.stagingFile, "-frames:v", "1", out],
        undefined,
        signal
      );
      if (!existsSync(out)) throw new Error(`截帧失败 @ ${times[i]}s`);
    }
  } else {
    await runCmd(
      ["ffmpeg", "-y", "-i", p.stagingFile, "-vf", `fps=${p.fps}`, "-start_number", "0", outPattern],
      undefined,
      signal
    );
  }

  const files = readdirSync(stageDir)
    .filter((f) => /^frame_\d+\.png$/.test(f))
    .sort();
  if (files.length === 0) throw new Error("未能从素材中提取任何帧");
  return { stageDir, files };
}

function cleanupStaging(stageDir: string, stagingFile: string) {
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(dirname(stagingFile), { recursive: true, force: true });
}

/** 暂存帧序列 → 素材入库 */
function saveMaterials(stageDir: string, files: string[], p: ExtractPayload): string[] {
  const base = (p.originName ?? "素材").trim() || "素材";
  // 视频/GIF 拆出的是 PNG 帧，来源标 extract，勿沿用 mp4/gif
  const source = p.mediaType === "mp4" || p.mediaType === "gif" ? "extract" : p.mediaType;
  const ids: string[] = [];
  files.forEach((file, i) => {
    const id = uid();
    const dir = join(STORAGE_ROOT, "materials", id);
    mkdirSync(dir, { recursive: true });
    const rawPath = join(dir, "raw.png");
    renameSync(`${stageDir}/${file}`, rawPath);
    const name = files.length > 1 ? `${base} #${i + 1}` : base;
    db.query(
      "INSERT INTO materials (id, name, raw_path, status, source, folder_id, created_at) VALUES (?, ?, ?, 'raw', ?, ?, ?)"
    ).run(id, name, rawPath, source, p.folderId ?? null, Date.now());
    ids.push(id);
  });
  return ids;
}

/** 拆帧任务：image 直接落盘；gif/mp4 走 ffmpeg；按 target 落到项目帧或素材库 */
export async function extractFrames(
  p: ExtractPayload,
  progress: (s: string) => void,
  enqueueMatting: EnqueueMatting,
  signal?: AbortSignal
) {
  if (signal?.aborted) throw new JobCancelledError();
  const { stageDir, files } = await extractToStaging(p, progress, signal);
  if (signal?.aborted) throw new JobCancelledError();
  progress(`入库 ${files.length} 项`);

  if (p.target.kind === "project") {
    const projectId = p.target.projectId;
    const rawDir = join(STORAGE_ROOT, "projects", projectId, "raw");
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(join(STORAGE_ROOT, "projects", p.target.projectId, "processed"), { recursive: true });
    const start = nextFrameNumber(rawDir);
    const frameIds: string[] = [];
    const source = p.mediaType === "mp4" || p.mediaType === "gif" ? "extract" : p.mediaType;
    // staging 已完整产出；同步落盘前使旧撤销链失效，防止旧快照删除新帧。
    invalidateProjectUndo(projectId);
    files.forEach((file, i) => {
      const id = uid();
      const rawPath = `${rawDir}/frame_${String(start + i).padStart(4, "0")}.png`;
      renameSync(`${stageDir}/${file}`, rawPath);
      appendFramePool(projectId,{id,raw_path:rawPath,status:p.autoMatting?"matting":"ready",source});
      frameIds.push(id);
    });
    cleanupStaging(stageDir, p.stagingFile);
    afterImportFrames(p.target.projectId, frameIds, p.autoMatting, enqueueMatting);
  } else {
    const ids = saveMaterials(stageDir, files, p);
    cleanupStaging(stageDir, p.stagingFile);
    afterImportMaterials(ids, p.autoMatting, enqueueMatting);
  }
}

/** 生成任务仅协调 provider 产出与生成产物提交。 */
export async function generateFrames(
  p: GeneratePayload,
  progress: (status: string) => void,
  enqueueMatting: EnqueueMatting,
  signal?: AbortSignal
): Promise<{ artifacts: ArtifactCommitResult[]; warning?: string }> {
  if (signal?.aborted) throw new JobCancelledError();
  let backgroundStage: string | null = null;
  let warning: string | undefined;
  try {
    let providerPayload = p;
    if (p.flattenBackground && p.referencePaths?.length) {
      const imageMagick = findImageMagick();
      if (!imageMagick) {
        warning = "未检测到 ImageMagick，已跳过垫底图";
        progress(warning);
      } else {
        backgroundStage = join(STORAGE_ROOT, "staging", `genbg_${uid()}`);
        mkdirSync(backgroundStage, { recursive: true });
        const referencePaths: string[] = [];
        for (let index = 0; index < p.referencePaths.length; index++) {
          if (signal?.aborted) throw new JobCancelledError();
          progress(`合成垫底图 ${index + 1}/${p.referencePaths.length}`);
          const output = join(backgroundStage, `reference_${String(index).padStart(2, "0")}.png`);
          await runCmd([
            imageMagick,
            p.referencePaths[index]!,
            "-background",
            p.flattenBackground,
            "-alpha",
            "remove",
            "-alpha",
            "off",
            output,
          ], undefined, signal);
          referencePaths.push(output);
        }
        providerPayload = { ...p, referencePaths };
      }
    }

    // adapter 在构造时读取 referencePaths，必须在垫底合成之后创建。
    const adapter = createProviderAdapter(providerPayload, progress, signal);
    const name = (p.name?.trim().slice(0, 48) || p.prompt.trim().slice(0, 24)) || "生成素材";
    const batchCount = p.batchCount ?? p.count;
    const batchIndex = p.batchIndex ?? 0;
    const artifacts = createGeneratedArtifactCommitter({
      target: p.target,
      count: batchCount,
      autoMatting: p.autoMatting,
      name,
      folderId: p.folderId,
      source: adapter.source,
      prompt: p.prompt,
      providerName: adapter.providerName,
      model: p.model ?? (adapter.model || undefined),
      size: p.size,
      enqueueMatting,
      intent: p.intent,
      characterPartSetId: p.characterPartSetId,
      referenceMaterialId: p.referenceMaterialId,
      gridRows: p.gridRows,
      gridCols: p.gridCols,
    });
    const committed: ArtifactCommitResult[] = [];

    const produceAndCommit = async (kind: "image" | "video", index: number) => {
      const allocation = artifacts.allocate(kind, index);
      try {
        await adapter.produce(allocation.path, index);
        return artifacts.commit(allocation);
      } catch (error) {
        artifacts.discard(allocation);
        throw error;
      }
    };

    try {
      if (p.mediaKind === "video") {
        progress("生成视频中");
        const result = await produceAndCommit("video", 0);
        committed.push(result);
        if (result.kind === "video") {
          progress("保存视频素材");
          if (p.target.kind === "project") progress("视频已存入素材库，请打开素材「抽帧」后再导入项目");
        }
        return { artifacts: committed, warning };
      }

      for (let index = 0; index < p.count; index++) {
        if (signal?.aborted) throw new JobCancelledError();
        const artifactIndex = batchIndex + index;
        progress(
          p.target.kind === "project"
            ? `生成第 ${artifactIndex + 1}/${batchCount} 帧`
            : `生成第 ${artifactIndex + 1}/${batchCount} 个素材`
        );
        const result = await produceAndCommit("image", artifactIndex);
        committed.push(result);
        if (result.kind === "video") {
          progress("CLI 产出为视频，已存入素材库（请自行抽帧）");
          return { artifacts: committed, warning };
        }
      }
      return { artifacts: committed, warning };
    } finally {
      // 已提交的部分产物即使遇到失败/取消也必须广播，并为 matting 状态补齐后续任务。
      artifacts.finish();
    }
  } finally {
    if (backgroundStage) rmSync(backgroundStage, { recursive: true, force: true });
  }
}
