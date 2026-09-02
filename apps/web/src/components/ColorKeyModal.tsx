import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Maximize, Pipette, X } from "lucide-react";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { useT } from "../i18n";
import { palette, removeColor } from "../imageops/client";
import type { RemoveColorOptions, RgbColor } from "../imageops/ops";
import { notify } from "../notice";
import IconBtn from "./IconBtn";

interface Props {
  image: Blob;
  title?: string;
  batchCount?: number;
  onConfirm: (blob: Blob, options: RemoveColorOptions) => void | Promise<void>;
  onClose: () => void;
}

const colorCss = ([red, green, blue]: RgbColor) => `rgb(${red} ${green} ${blue})`;
const colorHex = ([red, green, blue]: RgbColor) =>
  `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const optionsKey = (options: RemoveColorOptions) =>
  `${options.targets.map((color) => color.join(",")).join(";")}|${options.tolerance}|${options.softness ?? 0}`;

/** 素材色键抠图：画布吸色 + 主色色盘 + worker 实时预览。 */
export default function ColorKeyModal({ image, title, batchCount = 1, onConfirm, onClose }: Props) {
  const t = useT();
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [preview, setPreview] = useState<ImageBitmap | null>(null);
  const [targets, setTargets] = useState<RgbColor[]>([]);
  const [colors, setColors] = useState<RgbColor[]>([]);
  const [tolerance, setTolerance] = useState(0);
  const [softness, setSoftness] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const previewRequest = useRef(0);
  const previewResult = useRef<{ key: string; blob: Blob } | null>(null);
  useModalEscClose(onClose, !busy);

  const options = useMemo<RemoveColorOptions>(
    () => ({ targets, tolerance, softness }),
    [softness, targets, tolerance],
  );
  const currentKey = optionsKey(options);

  const fitView = useCallback((width: number, height: number, imageWidth: number, imageHeight: number) => {
    if (!width || !height || !imageWidth || !imageHeight) return;
    const nextZoom = Math.max(.1, Math.min(width / imageWidth, height / imageHeight, 32) * .92);
    setZoom(nextZoom);
    setPan({ x: (width - imageWidth * nextZoom) / 2, y: (height - imageHeight * nextZoom) / 2 });
  }, []);

  useEffect(() => {
    let alive = true;
    let bitmap: ImageBitmap | null = null;
    void createImageBitmap(image)
      .then((decoded) => {
        if (!alive) {
          decoded.close();
          return;
        }
        bitmap = decoded;
        setSource(decoded);
        const stage = stageRef.current;
        if (stage) fitView(stage.clientWidth, stage.clientHeight, decoded.width, decoded.height);
      })
      .catch((error) => notify(t("msg.image_decode_failed_msg", { msg: (error as Error).message })));
    void palette(image, 12).then((result) => {
      if (alive) setColors(result);
    }).catch(() => {
      if (alive) setColors([]);
    });
    return () => {
      alive = false;
      bitmap?.close();
    };
  }, [fitView, image, t]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      setCanvasSize({ width, height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const request = ++previewRequest.current;
    if (!targets.length) {
      previewResult.current = null;
      setPreviewBusy(false);
      setPreview((previous) => {
        previous?.close();
        return null;
      });
      return;
    }
    setPreviewBusy(true);
    const timer = window.setTimeout(() => {
      void removeColor(image, options)
        .then(async (blob) => {
          const bitmap = await createImageBitmap(blob);
          if (request !== previewRequest.current) {
            bitmap.close();
            return;
          }
          previewResult.current = { key: optionsKey(options), blob };
          setPreview((previous) => {
            previous?.close();
            return bitmap;
          });
        })
        .catch((error) => {
          if (request === previewRequest.current) notify(t("colorKey.previewFailed", { msg: (error as Error).message }));
        })
        .finally(() => {
          if (request === previewRequest.current) setPreviewBusy(false);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [image, options, t, targets.length]);

  useEffect(() => () => {
    previewRequest.current += 1;
    preview?.close();
  }, [preview]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const bitmap = preview ?? source;
    if (!canvas || !bitmap || !canvasSize.width || !canvasSize.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvasSize.width * dpr);
    canvas.height = Math.round(canvasSize.height * dpr);
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;
    const context = canvas.getContext("2d")!;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, canvasSize.width, canvasSize.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, pan.x, pan.y, source!.width * zoom, source!.height * zoom);
    context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border-focused").trim();
    context.strokeRect(pan.x - .5, pan.y - .5, source!.width * zoom + 1, source!.height * zoom + 1);
  }, [canvasSize, pan, preview, source, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      setZoom((current) => {
        const next = Math.min(64, Math.max(.1, current * (event.deltaY < 0 ? 1.25 : .8)));
        setPan((position) => ({
          x: x - (x - position.x) * next / current,
          y: y - (y - position.y) * next / current,
        }));
        return next;
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const addColor = (color: RgbColor) => {
    setTargets((current) => current.some((item) => item.every((value, index) => value === color[index]))
      ? current
      : [...current, color]);
  };

  const pickColor = (screenX: number, screenY: number) => {
    if (!source) return;
    const x = Math.floor((screenX - pan.x) / zoom);
    const y = Math.floor((screenY - pan.y) / zoom);
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) return;
    const sample = sampleRef.current ?? document.createElement("canvas");
    sampleRef.current = sample;
    sample.width = sample.height = 1;
    const context = sample.getContext("2d", { willReadFrequently: true })!;
    context.clearRect(0, 0, 1, 1);
    context.imageSmoothingEnabled = false;
    context.drawImage(source, x, y, 1, 1, 0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    if (pixel[3] === 0) return;
    addColor([pixel[0]!, pixel[1]!, pixel[2]!]);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (event.button === 1 || event.altKey) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      panRef.current = { x, y };
      return;
    }
    if (event.button === 0) pickColor(x, y);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!panRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    setPan((current) => ({ x: current.x + x - panRef.current!.x, y: current.y + y - panRef.current!.y }));
    panRef.current = { x, y };
  };

  const confirm = async () => {
    if (!targets.length || busy) return;
    setBusy(true);
    try {
      const cached = previewResult.current;
      const output = cached?.key === currentKey ? cached.blob : await removeColor(image, options);
      await onConfirm(output, options);
    } catch (error) {
      notify(t("colorKey.failed", { msg: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div className="modal-mask color-key-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="modal pixel-panel color-key-modal" initial={{ scale: .94, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: .94, y: 20 }} onClick={(event) => event.stopPropagation()}>
        <div className="form-inline">
          <div style={{ flex: 1 }}>
            <h2><Pipette size={18} /> {t("colorKey.title")}</h2>
            <div className="color-key-sub">{title}{batchCount > 1 ? ` · ${t("colorKey.batchCount", { count: batchCount })}` : ""}</div>
          </div>
          <IconBtn title={t("common.close")} disabled={busy} onClick={onClose}><X size={16} /></IconBtn>
        </div>

        <div className="color-key-workspace">
          <div className="color-key-stage" ref={stageRef}>
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => { panRef.current = null; }}
              onPointerCancel={() => { panRef.current = null; }}
            />
            {previewBusy && <span className="color-key-previewing">{t("colorKey.previewing")}</span>}
          </div>

          <aside className="color-key-controls">
            <div className="hint">{t("colorKey.pickHint")}</div>
            <button type="button" className="px-btn mini" disabled={!source} onClick={() => {
              if (source) fitView(canvasSize.width, canvasSize.height, source.width, source.height);
            }}><Maximize size={13} /> {t("colorKey.fit")}</button>

            <section>
              <label>{t("colorKey.selectedColors")}</label>
              <div className="color-key-swatches selected">
                {targets.length === 0 ? <span className="hint">{t("colorKey.noneSelected")}</span> : targets.map((color) => (
                  <button key={color.join(",")} type="button" className="color-key-swatch" style={{ background: colorCss(color) }} title={`${colorHex(color)} · ${t("colorKey.removeColor")}`} onClick={() => setTargets((current) => current.filter((item) => item !== color))}>
                    <X size={12} />
                  </button>
                ))}
              </div>
            </section>

            <section>
              <label>{t("colorKey.palette")}</label>
              <div className="color-key-swatches">
                {colors.map((color) => <button key={color.join(",")} type="button" className="color-key-swatch" style={{ background: colorCss(color) }} title={colorHex(color)} onClick={() => addColor(color)} />)}
              </div>
            </section>

            <label className="color-key-range">
              <span>{t("colorKey.tolerance")} <b>{tolerance}</b></span>
              <input type="range" min={0} max={255} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} />
            </label>
            <label className="color-key-range">
              <span>{t("colorKey.softness")} <b>{softness}</b></span>
              <input type="range" min={0} max={64} value={softness} onChange={(event) => setSoftness(Number(event.target.value))} />
            </label>
            <div className="hint">{t("colorKey.toleranceHint")}</div>
          </aside>
        </div>

        <div className="modal-actions">
          <button type="button" className="px-btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="px-btn accent" disabled={busy || !targets.length} onClick={() => void confirm()}>{busy ? t("common.submitting") : batchCount > 1 ? t("colorKey.applyBatch") : t("colorKey.confirm")}</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
