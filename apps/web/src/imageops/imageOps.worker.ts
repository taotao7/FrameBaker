// 图像处理 worker：解码 / 透明边扫描 / 剪裁编码都在 worker 线程，避免阻塞 UI
// 注：工程 lib 只有 DOM（无 webworker），这里用模块级 declare 收窄 postMessage 签名

import { computeImageAnalysis, computeOpaqueBounds, detectOpaqueComponents, extractPalette, removeColorPixels, warpImagePixels, type DetectComponentsOptions, type EraseStroke, type ImageOpRequest, type ImageOpResponse, type RemoveColorOptions } from "./ops";


declare function postMessage(message: ImageOpResponse): void;

function boundsFromBitmap(bitmap: ImageBitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return computeOpaqueBounds(imageData.data, imageData.width, imageData.height);
}

function componentsFromBitmap(bitmap: ImageBitmap, options?: DetectComponentsOptions) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return detectOpaqueComponents(imageData.data, imageData.width, imageData.height, options);
}

async function cropFromBitmap(bitmap: ImageBitmap, rect: { x: number; y: number; w: number; h: number }) {
  const canvas = new OffscreenCanvas(rect.w, rect.h);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return canvas.convertToBlob({ type: "image/png" });
}

function eraseStrokes(ctx: OffscreenCanvasRenderingContext2D, strokes: EraseStroke[]) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    const first = stroke.points[0];
    if (!first) continue;
    ctx.lineWidth = stroke.size;
    if (stroke.points.length === 1) {
      ctx.beginPath();
      ctx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

async function warpFromBitmap(bitmap: ImageBitmap, grid: [number, number], points: number[]) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const warped = warpImagePixels(imageData.data, imageData.width, imageData.height, grid, points);
  ctx.putImageData(new ImageData(warped, imageData.width, imageData.height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function removeColorFromBitmap(bitmap: ImageBitmap, options: RemoveColorOptions) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const output = removeColorPixels(imageData.data, imageData.width, imageData.height, options);
  ctx.putImageData(new ImageData(output, imageData.width, imageData.height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

function paletteFromBitmap(bitmap: ImageBitmap, maxColors: number) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return extractPalette(imageData.data, imageData.width, imageData.height, maxColors);
}

async function editFromBitmap(bitmap: ImageBitmap, strokes: EraseStroke[], quarterTurns: number, flipHorizontal: boolean) {
  const source = new OffscreenCanvas(bitmap.width, bitmap.height);
  const sourceCtx = source.getContext("2d")!;
  sourceCtx.drawImage(bitmap, 0, 0);
  eraseStrokes(sourceCtx, strokes);

  const turns = ((quarterTurns % 4) + 4) % 4;
  const output = new OffscreenCanvas(turns % 2 ? bitmap.height : bitmap.width, turns % 2 ? bitmap.width : bitmap.height);
  const ctx = output.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(output.width / 2, output.height / 2);
  ctx.rotate(turns * Math.PI / 2);
  ctx.scale(flipHorizontal ? -1 : 1, 1);
  ctx.drawImage(source, -bitmap.width / 2, -bitmap.height / 2);
  return output.convertToBlob({ type: "image/png" });
}

self.onmessage = async (e: MessageEvent<ImageOpRequest>) => {
  const { id, op, blob, rect, strokes, quarterTurns, flipHorizontal, componentOptions, warpGrid, warpPoints, removeColorOptions, maxColors } = e.data;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    if (op === "bounds") {
      const bounds = boundsFromBitmap(bitmap);
      postMessage({ id, ok: true, rect: bounds });
    } else if (op === "components") {
      postMessage({ id, ok: true, rects: componentsFromBitmap(bitmap, componentOptions) });
    } else if (op === "crop") {
      if (!rect) throw new Error("crop 缺少 rect");
      const out = await cropFromBitmap(bitmap, rect);
      postMessage({ id, ok: true, blob: out });
    } else if (op === "warp") {
      if (!warpGrid || !warpPoints) throw new Error("warp 缺少 warpGrid/warpPoints");
      const out = await warpFromBitmap(bitmap, warpGrid, warpPoints);
      postMessage({ id, ok: true, blob: out });
    } else if (op === "remove-color") {
      if (!removeColorOptions) throw new Error("remove-color 缺少参数");
      const out = await removeColorFromBitmap(bitmap, removeColorOptions);
      postMessage({ id, ok: true, blob: out });
    } else if (op === "palette") {
      postMessage({ id, ok: true, colors: paletteFromBitmap(bitmap, maxColors ?? 12) });
    } else if (op === "analyze") {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      postMessage({ id, ok: true, analysis: computeImageAnalysis(imageData.data, imageData.width, imageData.height) });
    } else {

      const out = await editFromBitmap(bitmap, strokes ?? [], quarterTurns ?? 0, flipHorizontal ?? false);
      postMessage({ id, ok: true, blob: out });

    }
  } catch (err) {
    postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    bitmap?.close();
  }
};
