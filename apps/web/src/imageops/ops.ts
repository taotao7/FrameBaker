// 环境无关的图像纯计算：worker 与主线程降级路径共用

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageAnalysis {
  width: number;
  height: number;
  bounds: CropRect | null;
  opaqueRatio: number;
  significantComponents: number;
  sample: number[];
}

export type SkeletalPartQualityIssueCode = "empty" | "touches-edge" | "fragmented" | "duplicate" | "mirrored-duplicate";

export interface SkeletalPartQualityIssue {
  code: SkeletalPartQualityIssueCode;
  cells: number[];
}

export interface EditPoint {
  x: number;
  y: number;
}

export interface EraseStroke {
  size: number;
  points: EditPoint[];

}

export type RgbColor = [number, number, number];

export interface RemoveColorOptions {
  targets: RgbColor[];
  /** 切比雪夫距离阈值：0 仅精确匹配，255 清除全部颜色。 */
  tolerance: number;
  /** 阈值外的 alpha 线性过渡带宽；0 保持像素风硬边。 */
  softness?: number;
}

/** worker 消息协议（Blob 走 structured clone，无需手动 transfer） */
/** 连通域自动检测参数（阅读顺序返回不透明部件包围盒）。 */
export interface DetectComponentsOptions {
  alphaThreshold?: number;
  /** 面积下限占总不透明像素比例（滤除碎屑）。 */
  minAreaRatio?: number;
  /** 面积绝对下限像素。 */
  minAreaPixels?: number;
  /** 保留最大的前 N 个部件。 */
  maxComponents?: number;
}

export interface ImageOpRequest {
  id: number;

  op: "bounds" | "crop" | "analyze" | "edit" | "components" | "warp" | "remove-color" | "palette";

  blob: Blob;
  rect?: CropRect;
  strokes?: EraseStroke[];
  quarterTurns?: number;
  flipHorizontal?: boolean;
  componentOptions?: DetectComponentsOptions;
  /** 自由变形网格 [列数, 行数]，节点均匀铺满 [0,w]×[0,h]。 */
  warpGrid?: [number, number];
  /** 自由变形节点归一化位移（行优先，dx 相对宽、dy 相对高），长度 2·cols·rows。 */
  warpPoints?: number[];
  removeColorOptions?: RemoveColorOptions;
  maxColors?: number;
}

export interface ImageOpResponse {
  id: number;
  ok: boolean;
  rect?: CropRect | null;
  rects?: CropRect[];
  blob?: Blob;
  analysis?: ImageAnalysis;
  colors?: RgbColor[];
  error?: string;
}

/**
 * 按目标色的最小切比雪夫距离清除像素。RGB 保持不变，只按原 alpha 乘以
 * 阈值外过渡比例，因而不会把原本半透明/透明像素重新变为不透明。
 */
export function removeColorPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: RemoveColorOptions,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data);
  if (!options.targets.length) return out;
  const tolerance = Math.max(0, Math.min(255, Math.round(options.tolerance)));
  const softness = Math.max(0, Math.min(64, Math.round(options.softness ?? 0)));
  const pixels = Math.min(width * height, Math.floor(data.length / 4));
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    let distance = 255;
    for (const target of options.targets) {
      distance = Math.min(
        distance,
        Math.max(
          Math.abs(data[offset]! - target[0]),
          Math.abs(data[offset + 1]! - target[1]),
          Math.abs(data[offset + 2]! - target[2]),
        ),
      );
      if (distance === 0) break;
    }
    if (distance <= tolerance) {
      out[offset + 3] = 0;
    } else if (softness > 0 && distance < tolerance + softness) {
      out[offset + 3] = Math.round(data[offset + 3]! * (distance - tolerance) / softness);
    }
  }
  return out;
}

/**
 * 提取主色：第一遍按 RGB 各 5 个高位聚类，第二遍只在主桶内统计精确颜色。
 * 返回桶内出现最多的真实 RGB，而非量化中心，保证色盘颜色在 tolerance=0 时仍可精确命中。
 */
export function extractPalette(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  maxColors: number,
): RgbColor[] {
  const limit = Math.max(0, Math.floor(maxColors));
  if (limit === 0) return [];
  const pixels = Math.min(width * height, Math.floor(data.length / 4));
  const bucketCounts = new Uint32Array(1 << 15);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    if (data[offset + 3]! < 128) continue;
    const bucket = (data[offset]! >> 3) << 10 | (data[offset + 1]! >> 3) << 5 | data[offset + 2]! >> 3;
    bucketCounts[bucket]!++;
  }
  const buckets = Array.from(bucketCounts, (count, bucket) => ({ bucket, count }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.bucket - b.bucket)
    .slice(0, limit);
  if (!buckets.length) return [];

  const selected = new Map(buckets.map((entry, index) => [entry.bucket, index]));
  const exactCounts = buckets.map(() => new Map<number, number>());
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    if (data[offset + 3]! < 128) continue;
    const red = data[offset]!;
    const green = data[offset + 1]!;
    const blue = data[offset + 2]!;
    const bucket = (red >> 3) << 10 | (green >> 3) << 5 | blue >> 3;
    const index = selected.get(bucket);
    if (index == null) continue;
    const color = red << 16 | green << 8 | blue;
    const counts = exactCounts[index]!;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return exactCounts.map((counts) => {
    let bestColor = 0;
    let bestCount = -1;
    for (const [color, count] of counts) {
      if (count > bestCount) {
        bestColor = color;
        bestCount = count;
      }
    }
    return [bestColor >> 16 & 255, bestColor >> 8 & 255, bestColor & 255];
  });
}

/** 扫描 alpha>0 像素的最小包围盒（像素图「裁透明边」）；全透明返回 null */
export function computeOpaqueBounds(data: Uint8ClampedArray, width: number, height: number, alphaThreshold = 0): CropRect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const ANALYSIS_ALPHA_THRESHOLD = 8;
const SAMPLE_SIZE = 16;

/**
 * 连通域自动检测：4 连通洪泛扫描 alpha>阈值 的不透明块，返回按阅读顺序
 * （上到下分行带、行内左到右）排列的显著部件包围盒。用于精灵图按部件而非
 * 均匀网格切分，避免切穿部件。碎屑按面积阈值滤除。
 */
export function detectOpaqueComponents(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: DetectComponentsOptions = {},
): CropRect[] {
  const alphaThreshold = options.alphaThreshold ?? ANALYSIS_ALPHA_THRESHOLD;
  const total = width * height;
  if (total <= 0) return [];
  const foreground = (index: number) => data[index * 4 + 3] > alphaThreshold;
  let opaquePixels = 0;
  for (let i = 0; i < total; i++) if (foreground(i)) opaquePixels++;
  if (opaquePixels === 0) return [];

  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const components: Array<{ rect: CropRect; area: number }> = [];
  for (let start = 0; start < total; start++) {
    if (visited[start] || !foreground(start)) continue;
    let read = 0;
    let write = 0;
    let area = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    visited[start] = 1;
    queue[write++] = start;
    while (read < write) {
      const index = queue[read++];
      area++;
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const visit = (next: number) => {
        if (!visited[next] && foreground(next)) {
          visited[next] = 1;
          queue[write++] = next;
        }
      };
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
    components.push({ area, rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
  }

  const minArea = Math.max(options.minAreaPixels ?? 16, Math.ceil(opaquePixels * (options.minAreaRatio ?? 0.005)));
  let significant = components.filter((component) => component.area >= minArea);
  if (!significant.length) significant = [components.reduce((largest, current) => (current.area > largest.area ? current : largest))];
  if (options.maxComponents && significant.length > options.maxComponents) {
    significant = [...significant].sort((a, b) => b.area - a.area).slice(0, options.maxComponents);
  }

  // 阅读顺序：中位高度的行带聚合，行带内按中心 x 排序。
  const sortedHeights = significant.map((component) => component.rect.h).sort((a, b) => a - b);
  const medianHeight = sortedHeights.length ? sortedHeights[Math.floor(sortedHeights.length / 2)] : 1;
  const band = Math.max(1, medianHeight * 0.6);
  return significant
    .map((component) => ({ rect: component.rect, cx: component.rect.x + component.rect.w / 2, cy: component.rect.y + component.rect.h / 2 }))
    .sort((a, b) => (Math.floor(a.cy / band) - Math.floor(b.cy / band)) || (a.cx - b.cx))
    .map((entry) => entry.rect);
}

function countSignificantComponents(data: Uint8ClampedArray, width: number, height: number, opaquePixels: number): number {
  if (opaquePixels === 0) return 0;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const areas: number[] = [];
  const foreground = (index: number) => data[index * 4 + 3] > ANALYSIS_ALPHA_THRESHOLD;

  for (let start = 0; start < width * height; start++) {
    if (visited[start] || !foreground(start)) continue;
    let read = 0;
    let write = 0;
    let area = 0;
    visited[start] = 1;
    queue[write++] = start;
    while (read < write) {
      const index = queue[read++];
      area++;
      const x = index % width;
      const y = Math.floor(index / width);
      const visit = (next: number) => {
        if (visited[next] || !foreground(next)) return;
        visited[next] = 1;
        queue[write++] = next;
      };
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
    areas.push(area);
  }

  const minimumArea = Math.max(4, Math.ceil(opaquePixels * .02));
  return areas.filter((area) => area >= minimumArea).length;
}

function sampleOpaqueBounds(data: Uint8ClampedArray, width: number, bounds: CropRect | null): number[] {
  const sample = new Array<number>(SAMPLE_SIZE * SAMPLE_SIZE * 4).fill(0);
  if (!bounds) return sample;
  for (let sy = 0; sy < SAMPLE_SIZE; sy++) {
    const y0 = bounds.y + Math.floor(sy * bounds.h / SAMPLE_SIZE);
    const y1 = bounds.y + Math.max(Math.floor((sy + 1) * bounds.h / SAMPLE_SIZE), Math.floor(sy * bounds.h / SAMPLE_SIZE) + 1);
    for (let sx = 0; sx < SAMPLE_SIZE; sx++) {
      const x0 = bounds.x + Math.floor(sx * bounds.w / SAMPLE_SIZE);
      const x1 = bounds.x + Math.max(Math.floor((sx + 1) * bounds.w / SAMPLE_SIZE), Math.floor(sx * bounds.w / SAMPLE_SIZE) + 1);
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let opaque = 0;
      let pixels = 0;
      for (let y = y0; y < Math.min(y1, bounds.y + bounds.h); y++) {
        for (let x = x0; x < Math.min(x1, bounds.x + bounds.w); x++) {
          const index = (y * width + x) * 4;
          pixels++;
          alpha += data[index + 3];
          if (data[index + 3] <= ANALYSIS_ALPHA_THRESHOLD) continue;
          red += data[index];
          green += data[index + 1];
          blue += data[index + 2];
          opaque++;
        }
      }
      const out = (sy * SAMPLE_SIZE + sx) * 4;
      sample[out] = opaque ? Math.round(red / opaque / 17) : 0;
      sample[out + 1] = opaque ? Math.round(green / opaque / 17) : 0;
      sample[out + 2] = opaque ? Math.round(blue / opaque / 17) : 0;
      sample[out + 3] = pixels ? Math.round(alpha / pixels / 17) : 0;
    }
  }
  return sample;
}

/** 为质量检查提取透明边、连通主体和归一化视觉采样。 */
export function computeImageAnalysis(data: Uint8ClampedArray, width: number, height: number): ImageAnalysis {
  const bounds = computeOpaqueBounds(data, width, height, ANALYSIS_ALPHA_THRESHOLD);
  let opaquePixels = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > ANALYSIS_ALPHA_THRESHOLD) opaquePixels++;
  }
  return {
    width,
    height,
    bounds,
    opaqueRatio: width && height ? opaquePixels / (width * height) : 0,
    significantComponents: countSignificantComponents(data, width, height, opaquePixels),
    sample: sampleOpaqueBounds(data, width, bounds),
  };
}

/** 归一化采样相似度；mirror=true 时水平翻转第二个部件。 */
export function imageAnalysisSimilarity(a: ImageAnalysis, b: ImageAnalysis, mirror = false): number {
  if (!a.bounds || !b.bounds || a.sample.length !== b.sample.length) return 0;
  let difference = 0;
  for (let y = 0; y < SAMPLE_SIZE; y++) {
    for (let x = 0; x < SAMPLE_SIZE; x++) {
      const ai = (y * SAMPLE_SIZE + x) * 4;
      const bx = mirror ? SAMPLE_SIZE - 1 - x : x;
      const bi = (y * SAMPLE_SIZE + bx) * 4;
      const aa = a.sample[ai + 3];
      const ba = b.sample[bi + 3];
      if (aa === 0 && ba === 0) continue;
      if (aa === 0 || ba === 0) {
        difference += 1;
        continue;
      }
      const alphaDifference = Math.abs(aa - ba) / 15;
      const colorDifference = (
        Math.abs(a.sample[ai] - b.sample[bi])
        + Math.abs(a.sample[ai + 1] - b.sample[bi + 1])
        + Math.abs(a.sample[ai + 2] - b.sample[bi + 2])
      ) / 45;
      difference += alphaDifference * .35 + colorDifference * .65;
    }
  }
  return Math.max(0, 1 - difference / (SAMPLE_SIZE * SAMPLE_SIZE));
}

/**
 * 骨骼分件硬性质量闸门。这里只拦截可由像素证实的错误；
 * 头/骨盆/手等语义仍需在提交前由逐格人工复核。
 */
export function findSkeletalPartQualityIssues(analyses: ImageAnalysis[], standardHumanoidLayout = true, allowTightBounds = false): SkeletalPartQualityIssue[] {
  const issues: SkeletalPartQualityIssue[] = [];
  const oppositeSidePairs = standardHumanoidLayout ? new Set(["4:6", "5:7", "8:10", "9:11"]) : new Set<string>();
  analyses.forEach((analysis, index) => {
    const cell = index + 1;
    if (!analysis.bounds) {
      issues.push({ code: "empty", cells: [cell] });
      return;
    }
    const { bounds } = analysis;
    if (!allowTightBounds && (bounds.x === 0 || bounds.y === 0 || bounds.x + bounds.w === analysis.width || bounds.y + bounds.h === analysis.height)) {
      issues.push({ code: "touches-edge", cells: [cell] });
    }
    if (analysis.significantComponents > 1) issues.push({ code: "fragmented", cells: [cell] });
  });

  for (let left = 0; left < analyses.length; left++) {
    const a = analyses[left];
    if (!a.bounds) continue;
    for (let right = left + 1; right < analyses.length; right++) {
      const b = analyses[right];
      if (!b.bounds) continue;
      const aspectA = a.bounds.w / a.bounds.h;
      const aspectB = b.bounds.w / b.bounds.h;
      const oppositeSides = oppositeSidePairs.has(`${left}:${right}`);
      const sameShape = Math.abs(aspectA - aspectB) / Math.max(aspectA, aspectB) < (oppositeSides ? .08 : .04)
        && Math.abs(a.opaqueRatio - b.opaqueRatio) < (oppositeSides ? .03 : .015);
      if (!sameShape) continue;
      const direct = imageAnalysisSimilarity(a, b);
      if (direct >= (oppositeSides ? .84 : .995)) {
        issues.push({ code: "duplicate", cells: [left + 1, right + 1] });
      } else if (imageAnalysisSimilarity(a, b, true) >= (oppositeSides ? .9 : .997)) {
        issues.push({ code: "mirrored-duplicate", cells: [left + 1, right + 1] });
      }
    }
  }
  return issues;
}

/**
 * 自由变形 warp：静止网格节点均匀铺满 [0,w]×[0,h]（grid = [列数, 行数]，行优先），
 * 变形后节点 = 静止位置 + (dx·w, dy·h)。每个 grid quad 拆两个三角形，对变形后
 * 三角形做包围盒光栅化，用重心坐标反查静止三角形内对应位置的源像素，
 * nearest-neighbor（Math.round）取样。输出同尺寸；未被任何三角形覆盖的像素
 * 保持透明（0），越界源坐标裁剪。纯计算，worker / 主线程降级 / 测试三端共用。
 */
export function warpImagePixels(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  grid: [number, number],
  points: number[],
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const [cols, rows] = grid;
  if (width <= 0 || height <= 0 || cols < 2 || rows < 2 || points.length < 2 * cols * rows) return out;

  // 静止 / 变形后节点坐标（像素坐标系，[0,w]×[0,h]）
  const rest = new Float64Array(cols * rows * 2);
  const moved = new Float64Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 2;
      const x = c / (cols - 1) * width;
      const y = r / (rows - 1) * height;
      rest[i] = x;
      rest[i + 1] = y;
      moved[i] = x + points[i]! * width;
      moved[i + 1] = y + points[i + 1]! * height;
    }
  }

  // 光栅化一个三角形：遍历变形后三角形包围盒内的像素中心，
  // 重心坐标换算回静止三角形位置，nearest-neighbor 取源像素。
  const rasterize = (a: number, b: number, c: number) => {
    const ax = moved[a * 2]!, ay = moved[a * 2 + 1]!;
    const bx = moved[b * 2]!, by = moved[b * 2 + 1]!;
    const cx = moved[c * 2]!, cy = moved[c * 2 + 1]!;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) return; // 退化三角形跳过
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    const rax = rest[a * 2]!, ray = rest[a * 2 + 1]!;
    const rbx = rest[b * 2]!, rby = rest[b * 2 + 1]!;
    const rcx = rest[c * 2]!, rcy = rest[c * 2 + 1]!;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + .5;
        const py = y + .5;
        const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const wc = 1 - wa - wb;
        // 少量容差，避免相邻三角形共享边出现裂缝
        if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
        const sx = Math.round(wa * rax + wb * rbx + wc * rcx - .5);
        const sy = Math.round(wa * ray + wb * rby + wc * rcy - .5);
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue; // 越界源坐标裁剪
        const si = (sy * width + sx) * 4;
        const di = (y * width + x) * 4;
        out[di] = src[si]!;
        out[di + 1] = src[si + 1]!;
        out[di + 2] = src[si + 2]!;
        out[di + 3] = src[si + 3]!;
      }
    }
  };

  // 每个 grid quad 拆两个三角形
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const tl = r * cols + c;
      const tr = tl + 1;
      const bl = tl + cols;
      const br = bl + 1;
      rasterize(tl, tr, br);
      rasterize(tl, br, bl);
    }
  }
  return out;
}

/** 自定义网格跳过透明余格；标准人形网格只允许明确标记的可选格留空。 */
export function reviewSkeletalGrid(analyses: ImageAnalysis[], requireEveryCell: boolean, optionalEmptyIndexes: number[] = [], allowTightBounds = false): { activeIndexes: number[]; issues: SkeletalPartQualityIssue[] } {
  if (requireEveryCell) {
    const optional = new Set(optionalEmptyIndexes);
    const activeIndexes = analyses.flatMap((analysis, index) => analysis.bounds || !optional.has(index) ? [index] : []);
    const issues = findSkeletalPartQualityIssues(analyses, true, allowTightBounds).filter((issue) => !(issue.code === "empty" && optional.has(issue.cells[0] - 1)));
    return { activeIndexes, issues };
  }
  const activeIndexes = analyses.flatMap((analysis, index) => analysis.bounds ? [index] : []);
  if (!activeIndexes.length) return { activeIndexes, issues: [{ code: "empty", cells: [1] }] };
  const issues = findSkeletalPartQualityIssues(activeIndexes.map((index) => analyses[index]), false, allowTightBounds).map((issue) => ({
    ...issue,
    cells: issue.cells.map((cell) => activeIndexes[cell - 1] + 1),
  }));
  return { activeIndexes, issues };
}
