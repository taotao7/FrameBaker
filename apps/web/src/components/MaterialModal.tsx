import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bone, Crop, Film, Grid3x3, Layers3, MoveHorizontal, Pencil, PersonStanding, Pipette, RefreshCw, Send, Trash2, Undo2, Wand2, X } from "lucide-react";
import { api, materialFileUrl, materialImageUrl, type Material, type Project } from "../api";
import { getLocale, useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { askConfirm, notify } from "../notice";
import { SOURCE_LABEL_KEYS } from "../sourceLabel";
import { useServerConfig } from "../config";
import IconBtn from "./IconBtn";
import ColorKeyModal from "./ColorKeyModal";
import CropModal from "./CropModal";
import GridSplitModal from "./GridSplitModal";
import ActionGenModal from "./ActionGenModal";
import MattingOption from "./MattingOption";
import VideoExtractModal from "./VideoExtractModal";
import VideoPlayer from "./VideoPlayer";
import LayerSplitModal from "./LayerSplitModal";
import { useMaterialEditor } from "./MaterialEditor";

interface Props {
  material: Material;
  v: number;
  initialAction?: MaterialDetailAction;
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
  onDecomposeCharacter: () => void;
}

export type MaterialDetailAction = "crop" | "frame-split" | "skeletal-split" | "actions" | "directions";

/** 素材详情：图片对比滑杆 / 视频预览 + 抽帧编辑器；抠图/还原/导入/删除 */
export default function MaterialModal({ material: m, v, initialAction, onClose, onChanged, onToast, onDecomposeCharacter }: Props) {
  const t = useT();
  const openMaterialEditor = useMaterialEditor();
  useModalEscClose(onClose);
  const isVideo = m.kind === "video";
  const guidedSkeletalSplit = m.metadata.intent === "skeletal-parts" || m.metadata.intent === "skeletal-decompose";
  const [pos, setPos] = useState(50);
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [count, setCount] = useState(1);
  const [crop, setCrop] = useState<{ blob: Blob; slot: "raw" | "processed" } | null>(null);
  const [colorKeyImage, setColorKeyImage] = useState<Blob | null>(null);
  const [showSplit, setShowSplit] = useState(initialAction === "frame-split" || initialAction === "skeletal-split");
  const [splitLine, setSplitLine] = useState<"frame" | "skeletal">(initialAction === "skeletal-split" ? "skeletal" : "frame");
  const [showLayers, setShowLayers] = useState(false);
  const [showActions, setShowActions] = useState(initialAction === "actions" || initialAction === "directions");
  const [actionPreset, setActionPreset] = useState<"actions" | "directions">(initialAction === "directions" ? "directions" : "actions");
  const [showExtract, setShowExtract] = useState(false);
  const [extractFps, setExtractFps] = useState(8);
  const [extractMatte, setExtractMatte] = useState(true);
  const [showFullFps, setShowFullFps] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cfg = useServerConfig();
  const engine = cfg?.matting.engine;
  const engineAvailable = engine != null && engine !== "none";
  const imageLayersAvailable = cfg?.imageLayers.configured ?? false;

  useEffect(() => {
    if (initialAction !== "crop" || isVideo) return;
    let alive = true;
    setBusy(true);
    const slot = m.processed_path ? "processed" : "raw";
    fetch(materialImageUrl(m.id, v, slot))
      .then((res) => {
        if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
        return res.blob();
      })
      .then((blob) => {
        if (alive) setCrop({ blob, slot });
      })
      .catch((error) => {
        if (alive) notify((error as Error).message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [initialAction, isVideo, m.id, m.processed_path, t, v]);

  const updatePos = (e: React.PointerEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const p = ((e.clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(98, Math.max(2, p)));
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doMatting = () =>
    run(async () => {
      await api.matteMaterial(m.id);
      onToast(t("msg.matting_job_queued"));
    });

  const doUnmatting = () =>
    run(async () => {
      await api.unmatteMaterial(m.id);
      onChanged();
      onToast(t("msg.restored_to_original"));
    });

  const openCrop = () =>
    run(async () => {
      const slot = m.processed_path ? "processed" : "raw";
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      setCrop({ blob: await res.blob(), slot });
    });

  const doCrop = (blob: Blob) =>
    run(async () => {
      if (!crop) return;
      await api.replaceMaterialImage(m.id, blob, crop.slot);
      setCrop(null);
      onChanged();
      onToast(t("msg.crop_done"));
    });

  const openColorKey = () =>
    run(async () => {
      const slot = m.processed_path ? "processed" : "raw";
      const response = await fetch(materialImageUrl(m.id, v, slot));
      if (!response.ok) throw new Error(t("msg.failed_to_read_material_image"));
      setColorKeyImage(await response.blob());
    });

  const saveColorKey = (blob: Blob) =>
    run(async () => {
      await api.replaceMaterialImage(m.id, blob, "processed");
      setColorKeyImage(null);
      onChanged();
      onToast(t("colorKey.saved"));
    });

  const doExtract = () =>
    run(async () => {
      await api.extractMaterial(m.id, { fps: extractFps, autoMatting: extractMatte });
      onToast(t("msg.extract_job_queued_fps_fps", { fps: extractFps }));
      onClose();
    });

  const doDelete = async () => {
    if (!(await askConfirm(t("msg.delete_this_material_this_cannot_be_undone")))) return;
    await run(async () => {
      await api.batchDeleteMaterials([m.id]);
      onChanged();
      onToast(t("msg.material_deleted"));
      onClose();
    });
  };

  const openImport = () => {
    if (isVideo) {
      notify(t("msg.extract_frames_first_then_import_those_materials"), "info");
      return;
    }
    if (!showImport && projects === null) {
      api.listProjects().then(setProjects).catch((e) => notify(t("msg.load_project_failed_msg", { msg: e.message })));
    }
    setShowImport((s) => !s);
  };

  const doImport = (projectId: string) =>
    run(async () => {
      const r = await api.importMaterial(m.id, projectId, count);
      onToast(t("msg.imported_count_frames_into_project", { count: r.count }));
      setShowImport(false);
    });

  const prompt = typeof m.metadata.prompt === "string" ? m.metadata.prompt : null;

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}  >
      <motion.div
        className="modal pixel-panel mat-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{m.name}</h2>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </div>

        {isVideo ? (
          <div className="mat-video-wrap">
            {!showExtract && (
              <VideoPlayer src={materialFileUrl(m.id, v, "raw")} />
            )}
            <div className="hint">{t("msg.video_no_extract_during_gen_split_to_images_here_then_ma")}</div>
            {showFullFps && (
              <>
                <div className="form-row">
                  <label>{t("msg.extract_fps_fps", { fps: extractFps })}</label>
                  <input
                    type="range"
                    min={1}
                    max={24}
                    value={extractFps}
                    disabled={busy}
                    onChange={(e) => setExtractFps(Number(e.target.value))}
                  />
                </div>
                <MattingOption checked={extractMatte} onChange={setExtractMatte} />
              </>
            )}
          </div>
        ) : m.processed_path ? (
          <div
            className="compare"
            ref={wrapRef}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              updatePos(e);
            }}
            onPointerMove={(e) => {
              if (e.buttons & 1) updatePos(e);
            }}
          >
            <img className="cmp-img" src={materialImageUrl(m.id, v, "raw")} alt={t("msg.original")} draggable={false} />
            <div className="cmp-clip" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
              <img className="cmp-img" src={materialImageUrl(m.id, v, "processed")} alt={t("msg.matted")} draggable={false} />
            </div>
            <div className="cmp-divider" style={{ left: `${pos}%` }}>
              <span className="cmp-handle">
                <MoveHorizontal size={12} />
              </span>
            </div>
            <span className="cmp-tag left">{t("msg.original")}</span>
            <span className="cmp-tag right">{t("msg.matted")}</span>
          </div>
        ) : (
          <div className="compare single">
            <img className="cmp-img" src={materialImageUrl(m.id, v, "raw")} alt={m.name} draggable={false} />
            <span className="cmp-tag left">{t("common.material")}</span>
          </div>
        )}

        <div className="mat-meta">
          <span>{t("msg.source")} {t(SOURCE_LABEL_KEYS[m.source] ?? m.source)}</span>
          <span>{isVideo ? t("msg.video") : m.status === "matted" ? t("msg.matted_431ee1") : t("msg.original")}</span>
          <span>{new Date(m.created_at).toLocaleString(getLocale())}</span>
          {!isVideo && (
            <span className={`engine-status ${engineAvailable ? "ok" : "bad"}`}>
              <span className="dot" />
              {engine == null
                ? t("msg.detecting_engine")
                : engineAvailable
                  ? t("msg.engine_rembg_model", { model: cfg!.matting.model })
                  : t("msg.no_matting_engine_copy_only_scripts_setup_matting_sh_ps1")}
            </span>
          )}
          {prompt && <span className="mat-prompt">prompt: {prompt}</span>}
        </div>

        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          {isVideo ? (
            <>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn accent"
                disabled={busy}
                onClick={() => setShowExtract(true)}
              >
                <Film size={14} /> {t("videoExtract.open")}
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn"
                disabled={busy}
                onClick={() => setShowFullFps((s) => !s)}
              >
                {t("videoExtract.fullExtract")}
              </motion.button>
              {showFullFps && (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn accent-cyan"
                  disabled={busy}
                  onClick={() => void doExtract()}
                >
                  {busy ? t("common.submitting") : t("msg.extract_frames_fps_fps", { fps: extractFps })}
                </motion.button>
              )}
            </>
          ) : (
            <>
              <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn accent-cyan" disabled={busy} onClick={doMatting}>
                <Wand2 size={14} /> {m.status === "matted" ? t("msg.re_matte") : t("msg.run_matting")}
              </motion.button>
              {m.status === "matted" && (
                <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" disabled={busy} onClick={doUnmatting}>
                  <Undo2 size={14} /> {t("msg.restore_original")}
                </motion.button>
              )}
              <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" disabled={busy} onClick={openCrop}>
                <Crop size={14} /> {t("msg.crop")}
              </motion.button>
              <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" disabled={busy} onClick={openColorKey}>
                <Pipette size={14} /> {t("colorKey.action")}
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className={`px-btn${guidedSkeletalSplit ? " accent" : ""}`}
                disabled={busy}
                onClick={() => openMaterialEditor({ id: m.id, name: m.name, v, onSaved: onChanged })}
              >
                <Pencil size={14} /> {t("materialEdit.action")}
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn"
                disabled={busy}
                title={t("msg.split_sprite_grid_into_separate_materials_by_rows_cols")}
                onClick={() => {
                  setSplitLine("frame");
                  setShowSplit(true);
                }}
              >
                <Grid3x3 size={14} /> {t("msg.grid_split")}
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className={`px-btn${guidedSkeletalSplit ? " accent" : ""}`}
                disabled={busy}
                title={t("skeletal.split.qualityHint")}
                onClick={() => {
                  setSplitLine("skeletal");
                  setShowSplit(true);
                }}
              >
                <Bone size={14} /> {t("skeletal.split.reviewAndCreate")}
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn"
                disabled={busy}
                title={t("skeletal.generate.decomposeHint")}
                onClick={onDecomposeCharacter}
              >
                <PersonStanding size={14} /> {t("skeletal.generate.fromReference")}
              </motion.button>
              {imageLayersAvailable && <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn" disabled={busy} onClick={() => setShowLayers(true)}>
                <Layers3 size={14} /> {t("layers.action")}
              </motion.button>}
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn"
                disabled={busy}
                title={t("msg.use_this_material_as_ref_append_continuous_frames_repeat")}
                onClick={() => {
                  setActionPreset("actions");
                  setShowActions(true);
                }}
              >
                <PersonStanding size={14} /> {t("msg.multi_action_generate")}
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn"
                disabled={busy}
                title={t("msg.character_eight_view_action_hint")}
                onClick={() => {
                  setActionPreset("directions");
                  setShowActions(true);
                }}
              >
                <RefreshCw size={14} /> {t("msg.character_eight_view")}
              </motion.button>
            </>
          )}
          <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn accent" disabled={busy} onClick={openImport}>
            <Send size={14} /> {t("msg.import_to_project")}
          </motion.button>
          <div style={{ flex: 1 }} />
          <IconBtn className="danger" title={t("msg.delete_material")} disabled={busy} onClick={() => void doDelete()}>
            <Trash2 size={15} />
          </IconBtn>
        </div>

        {showImport && (
          <div className="mat-import">
            <div className="form-inline">
              <label className="px-check">
                {t("msg.duplicate_count")}
                <input
                  className="px-input num"
                  type="number"
                  min={1}
                  max={16}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
                />
              </label>
            </div>
            {projects === null ? (
              <div className="empty">{t("msg.loading_project")}</div>
            ) : projects.length === 0 ? (
              <div className="empty">{t("msg.no_projects_yet_create_one_on_projects_page")}</div>
            ) : (
              <div className="picker-list">
                {projects.map((p) => (
                  <button key={p.id} type="button" className="picker-row" disabled={busy} onClick={() => doImport(p.id)}>
                    <span className="picker-name">{p.name}</span>
                    <span className="picker-meta">{t("msg.count_frames", { count: p.frame_count ?? 0 })}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <AnimatePresence>
          {showLayers && <LayerSplitModal materialId={m.id} hasProcessed={Boolean(m.processed_path)} model={cfg?.imageLayers.model ?? ""} onClose={() => setShowLayers(false)} onQueued={() => { onToast(t("layers.queued")); setShowLayers(false); onClose(); }} />}
        </AnimatePresence>

        <AnimatePresence>
          {crop && (
            <CropModal
              image={crop.blob}
              title={m.name}
              subtitle={t("msg.target_slot", { slot: crop.slot === "processed" ? t("msg.matted") : t("msg.original") })}
              onConfirm={doCrop}
              onClose={() => setCrop(null)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {colorKeyImage && (
            <ColorKeyModal image={colorKeyImage} title={m.name} onConfirm={saveColorKey} onClose={() => setColorKeyImage(null)} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showSplit && (
            <GridSplitModal material={m} v={v} initialLine={splitLine} onClose={() => setShowSplit(false)} onDone={onChanged} onToast={onToast} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showActions && (
            <ActionGenModal material={m} v={v} initialPreset={actionPreset} onClose={() => setShowActions(false)} onToast={onToast} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showExtract && (
            <VideoExtractModal
              material={m}
              v={v}
              onClose={() => setShowExtract(false)}
              onToast={(msg) => {
                onToast(msg);
                onChanged();
              }}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
