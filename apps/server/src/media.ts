import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { STORAGE_ROOT } from "./db";
import { runCmd } from "./jobs/run";

const THUMBNAIL_ROOT = join(STORAGE_ROOT, "thumbnails");
const THUMBNAIL_MIN = 64;
const THUMBNAIL_MAX = 1024;
const THUMBNAIL_CONCURRENCY = 4;

let thumbnailRunning = 0;
const thumbnailQueue: Array<() => void> = [];
const thumbnailInflight = new Map<string, Promise<string | null>>();

/** Windows 自带 convert.exe 不是 ImageMagick；其他平台兼容 IM6 的 convert。 */
export function findImageMagick(): string | null {
  return Bun.which("magick") ?? (process.platform === "win32" ? null : Bun.which("convert"));
}

/** 图片列表只允许有限尺寸，避免把缩略图接口当成原图代理。 */
export function parseThumbnailSize(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  if (!Number.isInteger(size) || size < THUMBNAIL_MIN || size > THUMBNAIL_MAX) return null;
  return size;
}

function runThumbnailTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      thumbnailRunning += 1;
      void task()
        .then(resolve, reject)
        .finally(() => {
          thumbnailRunning -= 1;
          const next = thumbnailQueue.shift();
          if (next) next();
        });
    };
    if (thumbnailRunning < THUMBNAIL_CONCURRENCY) run();
    else thumbnailQueue.push(run);
  });
}

function thumbnailKey(sourcePath: string, size: number): { key: string; output: string } | null {
  try {
    const stat = statSync(sourcePath);
    const sourceKey = createHash("sha1").update(sourcePath).digest("hex").slice(0, 20);
    const version = `${Math.floor(stat.mtimeMs)}-${stat.size}`;
    const versionKey = createHash("sha1").update(version).digest("hex").slice(0, 16);
    const key = `${sourceKey}-${size}-${versionKey}`;
    return { key, output: join(THUMBNAIL_ROOT, `${key}.png`) };
  } catch {
    return null;
  }
}

/**
 * 生成并缓存 UI 缩略图。优先使用 ImageMagick，随后回退 ffmpeg；两者都没有时返回 null，由调用方回退原图，
 * 不影响导入、编辑和导出等核心流程；同时限制并发，避免素材页首开时拉起几十个进程。
 */
export function getThumbnailPath(sourcePath: string, size: number): Promise<string | null> {
  const keyed = thumbnailKey(sourcePath, size);
  if (!keyed) return Promise.resolve(null);
  const cached = thumbnailInflight.get(keyed.key);
  if (cached) return cached;

  const promise = runThumbnailTask(async () => {
    if (existsSync(keyed.output)) return keyed.output;
    const imageMagick = findImageMagick();
    const ffmpeg = imageMagick ? null : Bun.which("ffmpeg");
    if (!imageMagick && !ffmpeg) return null;
    mkdirSync(THUMBNAIL_ROOT, { recursive: true });
    const temporary = `${keyed.output}.${crypto.randomUUID()}.tmp.png`;
    try {
      if (imageMagick) {
        await runCmd(
          [imageMagick, sourcePath, "-thumbnail", `${size}x${size}>`, "-strip", "-define", "png:compression-level=9", temporary],
          undefined
        );
      } else {
        await runCmd([
          ffmpeg!, "-y", "-i", sourcePath,
          "-vf", `scale=w='min(${size},iw)':h='min(${size},ih)':force_original_aspect_ratio=decrease`,
          "-frames:v", "1", temporary,
        ]);
      }
      renameSync(temporary, keyed.output);
      return existsSync(keyed.output) ? keyed.output : null;
    } catch {
      return null;
    } finally {
      rmSync(temporary, { force: true });
    }
  });
  thumbnailInflight.set(keyed.key, promise);
  void promise.then(
    () => thumbnailInflight.delete(keyed.key),
    () => thumbnailInflight.delete(keyed.key)
  );
  return promise;
}

function entityTag(path: string): { etag: string; lastModified: string } {
  const stat = statSync(path);
  return {
    etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    lastModified: new Date(stat.mtimeMs).toUTCString(),
  };
}

/** 为图片响应提供条件请求和版本化缓存；v 参数存在时允许长期 immutable 缓存。 */
export function serveMediaFile(
  path: string,
  request: Request,
  contentType: string
): Response {
  const { etag, lastModified } = entityTag(path);
  const versioned = new URL(request.url).searchParams.has("v");
  const cacheControl = versioned ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    ETag: etag,
    "Last-Modified": lastModified,
  });
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Bun.file(path), { headers });
}

export function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp)$/i.test(basename(path));
}
