// 图像处理客户端：优先 Web Worker（OffscreenCanvas），不可用/出错时降级主线程 canvas

import { computeImageAnalysis, computeOpaqueBounds, detectOpaqueComponents, extractPalette, removeColorPixels, warpImagePixels, type CropRect, type DetectComponentsOptions, type EraseStroke, type ImageAnalysis, type ImageOpRequest, type ImageOpResponse, type RemoveColorOptions, type RgbColor } from "./ops";


let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: ImageOpResponse) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    // 同源绝对路径：服务端按需 Bun.build 下发（Bun HTML 打包不处理 new Worker(new URL(...))）
    const w = new Worker("/imageops/imageOps.worker.js", { type: "module" });
    const markBroken = () => {
      // 脚本/运行/消息解码错误：拒掉全部待处理请求，后续走主线程降级
      workerBroken = true;
      worker = null;
      w.terminate();
      for (const p of pending.values()) p.reject(new Error("图像 worker 不可用"));
      pending.clear();
    };
    w.onmessage = (e: MessageEvent<ImageOpResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      p.resolve(e.data);
    };
    w.onerror = markBroken;
    w.onmessageerror = markBroken;
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

function runInWorker(req: Omit<ImageOpRequest, "id">): Promise<ImageOpResponse> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("图像 worker 不可用"));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ ...req, id });
  });
}

// ---- 主线程降级实现（同一套纯函数，canvas 元素代替 OffscreenCanvas）----

async function mainBounds(blob: Blob): Promise<CropRect | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return computeOpaqueBounds(imageData.data, imageData.width, imageData.height);
  } finally {
    bitmap.close();
  }
}

async function mainComponents(blob: Blob, options?: DetectComponentsOptions): Promise<CropRect[]> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return detectOpaqueComponents(imageData.data, imageData.width, imageData.height, options);
  } finally {
    bitmap.close();
  }
}

async function mainCrop(blob: Blob, rect: CropRect): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = rect.w;
    canvas.height = rect.h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))), "image/png")
    );
  } finally {
    bitmap.close();
  }
}

function eraseStrokes(ctx: CanvasRenderingContext2D, strokes: EraseStroke[]) {
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

async function mainAnalyze(blob: Blob): Promise<ImageAnalysis> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return computeImageAnalysis(imageData.data, imageData.width, imageData.height);
  } finally {
    bitmap.close();
  }
}

async function mainRemoveColor(blob: Blob, options: RemoveColorOptions): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const output = removeColorPixels(imageData.data, imageData.width, imageData.height, options);
    ctx.putImageData(new ImageData(output, imageData.width, imageData.height), 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("toBlob 失败")), "image/png")
    );
  } finally {
    bitmap.close();
  }
}

async function mainPalette(blob: Blob, maxColors: number): Promise<RgbColor[]> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return extractPalette(imageData.data, imageData.width, imageData.height, maxColors);
  } finally {
    bitmap.close();
  }
}

async function mainWarp(blob: Blob, grid: [number, number], points: number[]): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const warped = warpImagePixels(imageData.data, imageData.width, imageData.height, grid, points);
    ctx.putImageData(new ImageData(warped, imageData.width, imageData.height), 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))), "image/png")
    );
  } finally {
    bitmap.close();
  }
}

async function mainEdit(blob: Blob, strokes: EraseStroke[], quarterTurns: number, flipHorizontal: boolean): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const source = document.createElement("canvas");
    source.width = bitmap.width;
    source.height = bitmap.height;
    const sourceCtx = source.getContext("2d")!;
    sourceCtx.drawImage(bitmap, 0, 0);
    eraseStrokes(sourceCtx, strokes);

    const turns = ((quarterTurns % 4) + 4) % 4;
    const output = document.createElement("canvas");
    output.width = turns % 2 ? bitmap.height : bitmap.width;
    output.height = turns % 2 ? bitmap.width : bitmap.height;
    const ctx = output.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.translate(output.width / 2, output.height / 2);
    ctx.rotate(turns * Math.PI / 2);
    ctx.scale(flipHorizontal ? -1 : 1, 1);
    ctx.drawImage(source, -bitmap.width / 2, -bitmap.height / 2);
    return await new Promise((resolve, reject) =>
      output.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))), "image/png")
    );

  } finally {
    bitmap.close();
  }
}

/** 透明像素包围盒；全透明返回 null。worker 失败自动降级主线程 */
export async function findOpaqueBounds(blob: Blob): Promise<CropRect | null> {
  try {
    const r = await runInWorker({ op: "bounds", blob });
    if (!r.ok) throw new Error(r.error ?? "bounds 失败");
    return r.rect ?? null;
  } catch {
    return mainBounds(blob);
  }
}

/** 连通域自动检测不透明部件包围盒（阅读顺序）；worker 失败自动降级主线程 */
export async function detectComponents(blob: Blob, options?: DetectComponentsOptions): Promise<CropRect[]> {
  try {
    const r = await runInWorker({ op: "components", blob, componentOptions: options });
    if (!r.ok || !r.rects) throw new Error(r.error ?? "components 失败");
    return r.rects;
  } catch {
    return mainComponents(blob, options);
  }
}

/** 按整数像素矩形剪裁并编码 PNG；worker 失败自动降级主线程 */
export async function cropImage(blob: Blob, rect: CropRect): Promise<Blob> {
  try {
    const r = await runInWorker({ op: "crop", blob, rect });
    if (!r.ok || !r.blob) throw new Error(r.error ?? "crop 失败");
    return r.blob;
  } catch {
    return mainCrop(blob, rect);
  }
}

/** 自由变形 warp（网格节点归一化位移）并编码 PNG；worker 失败自动降级主线程 */
export async function warpImage(blob: Blob, grid: [number, number], points: number[]): Promise<Blob> {
  try {
    const r = await runInWorker({ op: "warp", blob, warpGrid: grid, warpPoints: points });
    if (!r.ok || !r.blob) throw new Error(r.error ?? "warp 失败");
    return r.blob;
  } catch {
    return mainWarp(blob, grid, points);
  }
}

/** 应用橡皮擦笔迹、90° 旋转与水平镜像并编码 PNG；重放和编码优先在 worker 完成。 */
export async function editImage(blob: Blob, strokes: EraseStroke[], quarterTurns: number, flipHorizontal = false): Promise<Blob> {
  try {
    const r = await runInWorker({ op: "edit", blob, strokes, quarterTurns, flipHorizontal });
    if (!r.ok || !r.blob) throw new Error(r.error ?? "edit 失败");
    return r.blob;
  } catch {
    return mainEdit(blob, strokes, quarterTurns, flipHorizontal);

  }
}

/** 提取分件质量特征；worker 失败自动降级主线程。 */
export async function analyzeImage(blob: Blob): Promise<ImageAnalysis> {
  try {
    const r = await runInWorker({ op: "analyze", blob });
    if (!r.ok || !r.analysis) throw new Error(r.error ?? "analyze 失败");
    return r.analysis;
  } catch {
    return mainAnalyze(blob);
  }
}

/** 按选定颜色移除背景并编码 PNG；worker 失败自动降级主线程。 */
export async function removeColor(blob: Blob, options: RemoveColorOptions): Promise<Blob> {
  try {
    const response = await runInWorker({ op: "remove-color", blob, removeColorOptions: options });
    if (!response.ok || !response.blob) throw new Error(response.error ?? "remove-color 失败");
    return response.blob;
  } catch {
    return mainRemoveColor(blob, options);
  }
}

/** 提取图片主色；透明度低于 128 的像素不参与统计。 */
export async function palette(blob: Blob, maxColors = 12): Promise<RgbColor[]> {
  try {
    const response = await runInWorker({ op: "palette", blob, maxColors });
    if (!response.ok || !response.colors) throw new Error(response.error ?? "palette 失败");
    return response.colors;
  } catch {
    return mainPalette(blob, maxColors);
  }
}
