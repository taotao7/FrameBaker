import { Elysia, t } from "elysia";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CharacterBinding, MaterialRow } from "@framebaker/shared";
import { IMAGE_LAYER_COUNT_MAX, IMAGE_LAYER_COUNT_MIN } from "@framebaker/shared";
import { db, getMaterial, nextFrameIdx, renameMaterial, serializeMaterial, STORAGE_ROOT, uid } from "../db";
import { createGenerationJobs, createJob, createMattingJob } from "../queue";
import { EXTRACT_TIMESTAMPS_MAX, normalizeExtractTimestamps } from "../jobs/extract";
import { checkImageReferenceSupport, checkVideoSupport, resolveReferencePaths } from "../providerAdapter";
import { getImageLayerSettings, imageLayerConfigured } from "../provider";
import { broadcast } from "../ws";
import { appendFramePool, importFrameCellsToTarget, validateFrameImportTarget, type NewFrameCell } from "../timeline";
import { getThumbnailPath, isImagePath, parseThumbnailSize, serveMediaFile } from "../media";
import { beginProjectUndo } from "../undo";

function baseName(filename: string): string {
  const n = filename.split("/").pop() ?? filename;
  return n.includes(".") ? n.slice(0, n.lastIndexOf(".")) : n;
}

function extOf(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
}

export function createAutomaticCharacterPartSet(name: string | undefined, source: "generated" | "decomposed", referenceMaterialId?: string): string {
  const id = uid();
  const now = Date.now();
  db.query("INSERT INTO character_part_sets (id,name,source,reference_material_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, name?.trim() || "人物分件", source, referenceMaterialId ?? null, now, now);
  return id;
}

function bindingUsingMaterial(ids: Set<string>): string | null {
  const rows = db.query("SELECT projects.name, skeletal_projects.document FROM skeletal_projects JOIN projects ON projects.id = skeletal_projects.project_id").all() as Array<{ name: string; document: string }>;
  for (const row of rows) {
    const document = JSON.parse(row.document) as { character?: { binding?: CharacterBinding } | null };
    if (document.character?.binding?.attachments.some((attachment) => ids.has(attachment.materialId))) return row.name;
  }
  return null;
}

const materialNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortMaterialsByFrameNumber(materials: MaterialRow[]): MaterialRow[] {
  return [...materials].sort(
    (a, b) =>
      materialNameCollator.compare(a.name || "", b.name || "") ||
      a.created_at - b.created_at ||
      a.id.localeCompare(b.id)
  );
}

/** 把素材复制为项目帧追加到末尾；有抠图结果时两个槽位都以抠图图为准，返回新帧 id */
function importMaterialToProject(m: MaterialRow, projectId: string): string {
  const cell = prepareMaterialFrame(m, projectId);
  appendFramePool(projectId, cell);
  return cell.id;
}

function prepareMaterialFrame(m: MaterialRow, projectId: string): NewFrameCell {
  const processedSrc = m.processed_path && existsSync(m.processed_path) ? m.processed_path : null;
  const inputSrc = processedSrc ?? (m.raw_path && existsSync(m.raw_path) ? m.raw_path : null);
  if (!inputSrc) throw new Error(`素材文件缺失: ${m.id}`);
  if (/\.(mp4|mov|webm|avi)$/i.test(inputSrc)) {
    throw new Error(`「${m.name}」是视频素材，请先抽帧再导入项目`);
  }
  const frameId = uid();
  const rawDir = join(STORAGE_ROOT, "projects", projectId, "raw");
  const procDir = join(STORAGE_ROOT, "projects", projectId, "processed");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(procDir, { recursive: true });
  // mat_ 前缀：不会被拆帧扫描的 frame_\d+ 规则命中
  const rawPath = join(rawDir, `mat_${frameId}.png`);
  copyFileSync(inputSrc, rawPath);
  let procPath: string | null = null;
  if (processedSrc) {
    procPath = join(procDir, `${frameId}.png`);
    copyFileSync(processedSrc, procPath);
  }
  let metadata: Record<string, unknown> = { fromMaterial: m.id };
  try {
    metadata = { ...metadata, ...JSON.parse(m.metadata ?? "{}") };
  } catch {
    /* ignore */
  }
  return { id: frameId, raw_path: rawPath, processed_path: procPath, status: "ready", source: m.source, metadata: JSON.stringify(metadata) };
}

/** 素材图片/视频流式返回，processed 缺失回退 raw */
const materialImageHandler = ({
  params,
  query,
  request,
  status,
}: {
  params: { id: string };
  query: { type?: string; strict?: string; size?: string };
  request: Request;
  status: (code: number, msg: string) => unknown;
}) => {
  const m = getMaterial(params.id);
  if (!m) return status(404, "素材不存在");
  let path: string | null = query.type === "raw" ? m.raw_path : m.processed_path;
  if (query.strict === "1" && (!path || !existsSync(path))) return status(404, "指定图片槽位不存在");
  if (!path || !existsSync(path)) path = m.raw_path;
  if (!path || !existsSync(path)) return status(404, "文件不存在");
  const lower = path.toLowerCase();
  const contentType = lower.endsWith(".mp4")
    ? "video/mp4"
    : lower.endsWith(".webm")
      ? "video/webm"
      : lower.endsWith(".mov")
        ? "video/quicktime"
        : "image/png";
  const size = parseThumbnailSize(query.size);
  if (size && contentType.startsWith("image/") && isImagePath(path)) {
    return getThumbnailPath(path, size).then((thumbnail) =>
      serveMediaFile(thumbnail ?? path!, request, "image/png")
    );
  }
  return serveMediaFile(path, request, contentType);
};

export const materialsApi = new Elysia({ prefix: "/api" })
  // 素材列表（按创建时间倒序）
  .get("/materials", () => {
    const rows = db.query("SELECT * FROM materials ORDER BY created_at DESC").all() as MaterialRow[];
    return { materials: rows.map(serializeMaterial) };
  })
  .patch(
    "/materials/:id",
    ({ params, body, status }) => {
      const name = body.name.trim();
      if (!name) return status(400, "素材名称不能为空");
      const material = renameMaterial(params.id, name);
      if (!material) return status(404, "素材不存在");
      broadcast("material_updated", { id: params.id });
      return { material: serializeMaterial(material) };
    },
    { body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }) }
  )
  // 素材图片，processed 缺失回退 raw（.png 后缀别名：让 Pixi Assets 按扩展名命中 parser）
  .get("/materials/:id/image", materialImageHandler)
  .get("/materials/:id/image.png", materialImageHandler)
  // 上传素材：单图 → 直接入库；GIF/MP4 → 队列拆帧，每帧一个素材
  .post(
    "/materials/upload",
    async ({ body }) => {
      const origName = body.file.name ?? "素材";
      const ext = extOf(origName);
      const autoMatting = body.autoMatting === "true";

      if (ext === "gif" || ext === "mp4" || ext === "mov" || ext === "webm") {
        const stagingId = uid();
        const dir = join(STORAGE_ROOT, "staging", stagingId);
        mkdirSync(dir, { recursive: true });
        const stagingFile = join(dir, `input.${ext}`);
        await Bun.write(stagingFile, Buffer.from(await body.file.arrayBuffer()));
        const fps = Math.min(Math.max(parseInt(body.fps ?? "8", 10) || 8, 1), 60);
        const jobId = createJob("", "extract_frames", {
          extract: {
            stagingFile,
            mediaType: ext === "gif" ? "gif" : "mp4",
            fps,
            autoMatting,
            target: { kind: "materials" },
            originName: baseName(origName),
            folderId: body.folderId || null,
          },
        });
        return { jobId };
      }

      // PNG/JPG 等单图 → 1 个素材
      const id = uid();
      const dir = join(STORAGE_ROOT, "materials", id);
      mkdirSync(dir, { recursive: true });
      const rawPath = join(dir, "raw.png");
      await Bun.write(rawPath, Buffer.from(await body.file.arrayBuffer()));
      const processedPath = body.processedFile ? join(dir, "processed.png") : null;
      if (body.processedFile && processedPath) {
        await Bun.write(processedPath, Buffer.from(await body.processedFile.arrayBuffer()));
      }
      const folderId = body.folderId || null;
      let metadata: Record<string, unknown> = {};
      if (body.metadata) {
        try {
          const parsed = typeof body.metadata === "string" ? JSON.parse(body.metadata) as unknown : body.metadata;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
        } catch {
          // 非法 metadata 不阻断文件上传，仅按空对象保存。
        }
      }
      db.query(
        "INSERT INTO materials (id, name, raw_path, processed_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, 'image', ?, ?, ?)"
      ).run(id, baseName(origName) || "素材", rawPath, processedPath, processedPath ? "matted" : "raw", folderId, JSON.stringify(metadata), Date.now());
      if (autoMatting && !processedPath) createMattingJob("", "material", id);
      broadcast("materials_changed", {});
      return { materialId: id };
    },
    {
      body: t.Object({
        file: t.File(),
        processedFile: t.Optional(t.File()),
        metadata: t.Optional(t.Union([t.String(), t.Record(t.String(), t.Unknown())])),
        autoMatting: t.Optional(t.String()),
        fps: t.Optional(t.String()),
        folderId: t.Optional(t.String()),
      }),
    }
  )
  // CLI 生成素材（可选引用图）
  .post(
    "/materials/generate",
    ({ body, status }) => {
      // 引用图 id 解析 + 模板一致性前置校验（在创建 job 前就 400）
      const ref = resolveReferencePaths(body);
      if (ref.error) return status(400, ref.error);
      const videoErr = checkVideoSupport(body);
      if (videoErr) return status(400, videoErr);
      const skeletalIntent = body.intent === "skeletal-character" || body.intent === "skeletal-parts" || body.intent === "skeletal-decompose";
      const referenceMaterialId = body.referenceMaterialId ?? body.references?.find((item) => item.kind === "material")?.id;
      const characterPartSetId = body.characterPartSetId ?? (skeletalIntent
        ? createAutomaticCharacterPartSet(body.name, body.intent === "skeletal-decompose" ? "decomposed" : "generated", referenceMaterialId)
        : undefined);
      const jobId = createJob("", "generate_frames", {
        generate: {
          prompt: body.prompt,
          count: body.count,
          autoMatting: body.autoMatting ?? false,
          target: { kind: "materials" },
          name: body.name,
          referencePaths: ref.referencePaths,
          flattenBackground: body.flattenBackground,
          providerId: body.providerId,
          model: body.model,
          size: body.size,
          mediaKind: body.mediaKind,
          fps: body.fps,
          folderId: body.folderId ?? null,
          intent: body.intent,
          characterPartSetId,
          referenceMaterialId,
          gridRows: body.gridRows,
          gridCols: body.gridCols,
          followUp: body.followUp,
        },
      });
      return { jobId, characterPartSetId };
    },
    {
      body: t.Object({
        prompt: t.String(),
        count: t.Integer({ minimum: 1, maximum: 16 }),
        autoMatting: t.Optional(t.Boolean()),
        name: t.Optional(t.String()),
        referenceMaterialId: t.Optional(t.String()),
        referenceFrameId: t.Optional(t.String()),
        poseReferenceMaterialId: t.Optional(t.String()),
        poseReferenceFrameId: t.Optional(t.String()),
        references: t.Optional(t.Array(t.Object({
          kind: t.Union([t.Literal("material"), t.Literal("frame")]),
          id: t.String(),
        }), { maxItems: 10 })),
        flattenBackground: t.Optional(t.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
        providerId: t.Optional(t.String()),
        model: t.Optional(t.String()),
        size: t.Optional(t.String()),
        mediaKind: t.Optional(t.Union([t.Literal("image"), t.Literal("video")])),
        fps: t.Optional(t.Integer({ minimum: 1, maximum: 60 })),
        folderId: t.Optional(t.Union([t.String(), t.Null()])),
        intent: t.Optional(t.Union([t.Literal("frame-image"), t.Literal("frame-sheet"), t.Literal("frame-video"), t.Literal("skeletal-character"), t.Literal("skeletal-parts"), t.Literal("skeletal-decompose"), t.Literal("skeletal-repair-part"), t.Literal("motion-clip")])),
        characterPartSetId: t.Optional(t.String()),
        gridRows: t.Optional(t.Integer({ minimum: 1, maximum: 8 })),
        gridCols: t.Optional(t.Integer({ minimum: 1, maximum: 8 })),
        followUp: t.Optional(t.Object({ prompt: t.String({ minLength: 1 }), name: t.Optional(t.String()), autoMatting: t.Optional(t.Boolean()), gridRows: t.Optional(t.Integer({ minimum: 1, maximum: 8 })), gridCols: t.Optional(t.Integer({ minimum: 1, maximum: 8 })) })),
      }),
      beforeHandle({ body, status }) {
        if (body.followUp && body.intent !== "skeletal-character") return status(400, "后续生成任务仅用于完整角色两阶段分件");
        if ((body.gridRows == null) !== (body.gridCols == null) || (body.followUp && ((body.followUp.gridRows == null) !== (body.followUp.gridCols == null)))) return status(400, "骨骼分件网格需要同时提供行数和列数");
        if (body.intent === "skeletal-character" || body.intent === "skeletal-parts" || body.intent === "skeletal-decompose") {
          if ((body.mediaKind ?? "image") !== "image") return status(400, "骨骼部件生成意图仅支持图片模式");
          if (body.characterPartSetId && !db.query("SELECT 1 FROM character_part_sets WHERE id=?").get(body.characterPartSetId)) return status(400, "角色部件集不存在");
          if (body.intent === "skeletal-decompose" && !body.referenceMaterialId && !body.referenceFrameId && !body.references?.length) return status(400, "精灵拆分生成需要引用图片");
          if (body.intent === "skeletal-character") {
            if (!body.followUp) return status(400, "完整角色生成需要配置后续分件任务");
            const referenceError = checkImageReferenceSupport(body.providerId);
            if (referenceError) return status(400, referenceError);
          }
        }
      },
    }
  )
  // 图片场景分层：使用独立配置，前置校验后创建异步任务
  .post(
    "/materials/:id/layers",
    ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      const input = m.processed_path && existsSync(m.processed_path) ? m.processed_path : m.raw_path;
      if (!input || !existsSync(input) || /\.(mp4|mov|webm|avi|gif)$/i.test(input)) return status(400, "只支持图片素材分层");
      const settings = getImageLayerSettings(body.providerId);
      if (!imageLayerConfigured(settings)) return status(400, "图片分层服务未配置完整");
      const jobId = createJob("", "image_layers", { imageLayers: {
        materialId: m.id, model: settings.model, layers: body.layers,
        numInferenceSteps: body.numInferenceSteps, trueCfgScale: body.trueCfgScale,
        negativePrompt: body.negativePrompt?.trim() || undefined, seed: body.seed,
        autoMatting: body.autoMatting,
      } });
      return { jobId };
    },
    { body: t.Object({
      // providerId/model 仅兼容旧客户端；新请求使用独立 imageLayers 设置。
      providerId: t.Optional(t.String()), model: t.Optional(t.String()),
      layers: t.Integer({ minimum: IMAGE_LAYER_COUNT_MIN, maximum: IMAGE_LAYER_COUNT_MAX }),
      numInferenceSteps: t.Integer({ minimum: 1, maximum: 100 }),
      trueCfgScale: t.Number({ minimum: 0, maximum: 20 }),
      negativePrompt: t.Optional(t.String()), seed: t.Integer({ minimum: 0 }),
      autoMatting: t.Optional(t.Boolean()),
    }) }
  )
  // 执行抠图：入队异步执行（模型首次下载可能耗时数分钟，同步会挂死请求；与批量抠图同路径）
  .post("/materials/:id/matting", ({ params, status }) => {
    const m = getMaterial(params.id);
    if (!m) return status(404, "素材不存在");
    if (!m.raw_path || !existsSync(m.raw_path)) return status(400, "素材缺少 raw 文件");
    if (/\.(mp4|mov|webm|avi)$/i.test(m.raw_path)) return status(400, "视频素材不能抠图，请先抽帧");
    const r = createMattingJob("", "material", params.id);
    if (r.duplicate) return status(409, "该素材已有进行中的抠图任务");
    return { jobId: r.jobId };
  })
  // 视频抽帧：复制到 staging → extract_frames → 每帧一个素材（同文件夹）
  // body.timestamps 有值 → 定点抽帧（仅视频）；否则整段按 fps（GIF/视频）
  .post(
    "/materials/:id/extract",
    ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      if (!m.raw_path || !existsSync(m.raw_path)) return status(400, "素材缺少文件");
      const isGif = /\.(gif)$/i.test(m.raw_path);
      const isVideo = /\.(mp4|mov|webm|avi)$/i.test(m.raw_path);
      if (!isGif && !isVideo) return status(400, "仅视频/GIF 素材可抽帧");

      const rawTs = Array.isArray(body.timestamps) ? body.timestamps : null;
      if (rawTs) {
        if (isGif) return status(400, "GIF 不支持定点抽帧，请用 fps 整段拆帧");
        if (rawTs.length > EXTRACT_TIMESTAMPS_MAX) {
          return status(400, `最多 ${EXTRACT_TIMESTAMPS_MAX} 个时间点`);
        }
      }

      const stagingId = uid();
      const dir = join(STORAGE_ROOT, "staging", stagingId);
      mkdirSync(dir, { recursive: true });
      const ext = m.raw_path.includes(".") ? m.raw_path.split(".").pop()!.toLowerCase() : "mp4";
      const stagingFile = join(dir, `input.${ext}`);
      copyFileSync(m.raw_path, stagingFile);
      const fps = Math.min(Math.max(body.fps ?? 8, 1), 60);

      let mode: "fps" | "timestamps" = "fps";
      let timestamps: number[] | undefined;
      if (rawTs) {
        timestamps = normalizeExtractTimestamps(rawTs.map(Number));
        if (timestamps.length === 0) return status(400, "未提供有效抽帧时间点");
        mode = "timestamps";
      }

      const jobId = createJob("", "extract_frames", {
        extract: {
          stagingFile,
          mediaType: isGif ? "gif" : "mp4",
          fps,
          mode,
          timestamps,
          autoMatting: body.autoMatting ?? false,
          target: { kind: "materials" },
          originName: (m.name || "素材").replace(/\s*#\d+$/, "").trim() || "素材",
          folderId: body.folderId !== undefined ? body.folderId : m.folder_id,
        },
      });
      return { jobId };
    },
    {
      body: t.Object({
        fps: t.Optional(t.Integer({ minimum: 1, maximum: 60 })),
        timestamps: t.Optional(t.Array(t.Number(), { maxItems: 64 })),
        autoMatting: t.Optional(t.Boolean()),
        folderId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  )
  // 批量抠图：仅对未抠图（raw）入队；已抠图 / 视频 / 已有进行中任务跳过
  .post(
    "/materials/batch-matting",
    ({ body }) => {
      let count = 0;
      let skipped = 0;
      for (const id of body.ids) {
        const m = getMaterial(id);
        if (!m || !m.raw_path || !existsSync(m.raw_path)) continue;
        if (/\.(mp4|mov|webm|avi)$/i.test(m.raw_path) || m.status === "matted") {
          skipped++;
          continue;
        }
        const r = createMattingJob("", "material", id);
        if (r.duplicate) {
          skipped++;
          continue;
        }
        count++;
      }
      return { ok: true, count, skipped };
    },
    { body: t.Object({ ids: t.Array(t.String()) }) }
  )
  // 替换图片（剪裁工具产出）：slot=raw 覆盖原图；slot=processed 覆盖/建立抠图结果
  .post(
    "/materials/:id/replace-image",
    async ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      const bytes = Buffer.from(await body.file.arrayBuffer());
      if (!isPng(bytes)) return status(400, "替换图片必须是 PNG（请通过剪裁工具提交）");
      let target: string;
      if (body.slot === "raw") {
        if (!m.raw_path) return status(400, "素材缺少 raw 文件");
        target = m.raw_path;
      } else {
        target = m.processed_path ?? join(STORAGE_ROOT, "materials", params.id, "processed.png");
      }
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, bytes);
      if (body.slot === "processed" && (m.status !== "matted" || m.processed_path !== target)) {
        db.query("UPDATE materials SET status = 'matted', processed_path = ? WHERE id = ?").run(target, params.id);
      }
      broadcast("material_updated", { id: params.id });
      return { material: serializeMaterial(getMaterial(params.id)!) };
    },
    {
      body: t.Object({
        file: t.File(),
        slot: t.Union([t.Literal("raw"), t.Literal("processed")]),
      }),
    }
  )
  // 还原原图：删除 processed
  .post("/materials/:id/unmatting", ({ params, status }) => {
    const m = getMaterial(params.id);
    if (!m) return status(404, "素材不存在");
    if (m.processed_path && existsSync(m.processed_path)) rmSync(m.processed_path);
    db.query("UPDATE materials SET status = 'raw', processed_path = NULL WHERE id = ?").run(params.id);
    broadcast("material_updated", { id: params.id });
    return { material: serializeMaterial(getMaterial(params.id)!) };
  })
  // 导入到项目：追加 count 份帧
  .post(
    "/materials/:id/import",
    ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(body.projectId);
      if (!project) return status(404, "项目不存在");
      const count = Math.min(Math.max(body.count ?? 1, 1), 16);
      try {
        const frameIds: string[] = [];
        for (let i = 0; i < count; i++) frameIds.push(importMaterialToProject(m, body.projectId));
        broadcast("frames_changed", { projectId: body.projectId });
        return { ok: true, count, frameIds };
      } catch (e) {
        return status(500, (e as Error).message);
      }
    },
    {
      body: t.Object({ projectId: t.String(), count: t.Optional(t.Integer()) }),
      beforeHandle: ({ request, body }) => beginProjectUndo(request, body),
    }
  )
  // 批量删除
  .post(
    "/materials/batch-delete",
    ({ body, status }) => {
      const dependent = bindingUsingMaterial(new Set(body.ids));
      if (dependent) return status(409, `素材仍被骨骼项目「${dependent}」引用`);
      const stmt = db.query("DELETE FROM materials WHERE id = ?");
      let deleted = 0;
      for (const id of body.ids) {
        const m = getMaterial(id);
        if (!m) continue;
        db.transaction(() => {
          db.query("DELETE FROM character_part_set_members WHERE material_id = ?").run(id);
          db.query("UPDATE character_part_sets SET reference_material_id = NULL, updated_at = ? WHERE reference_material_id = ?").run(Date.now(), id);
          stmt.run(id);
        })();
        deleted++;
        rmSync(join(STORAGE_ROOT, "materials", id), { recursive: true, force: true });
      }
      broadcast("materials_changed", {});
      return { ok: true, deleted };
    },
    { body: t.Object({ ids: t.Array(t.String()) }) }
  )
  // 批量导入到项目（按素材名称中的帧编号自然升序，各 1 份）
  .post(
    "/materials/batch-import",
    ({ body, status }) => {
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(body.projectId);
      if (!project) return status(404, "项目不存在");
      try {
        const materials = sortMaterialsByFrameNumber(
          body.ids.map((id) => getMaterial(id)).filter((m): m is MaterialRow => m !== null)
        );
        if (body.target) validateFrameImportTarget(body.projectId, materials.length, body.target);
        const frameIds = body.target
          ? importFrameCellsToTarget(body.projectId, materials.map((m) => prepareMaterialFrame(m, body.projectId)), body.target)
          : materials.map((m) => importMaterialToProject(m, body.projectId));
        broadcast("frames_changed", { projectId: body.projectId });
        broadcast("timeline_changed", { projectId: body.projectId, axisId: body.target?.axisId });
        return { ok: true, count: frameIds.length, frameIds };
      } catch (e) {
        return status(400, (e as Error).message);
      }
    },
    {
      body: t.Object({ ids: t.Array(t.String()), projectId: t.String(), target: t.Optional(t.Object({ axisId: t.String(), trackId: t.String(), startStepId: t.Optional(t.String()) })) }),
      beforeHandle: ({ request, body }) => beginProjectUndo(request, body),
    }
  );
