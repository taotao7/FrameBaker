import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bone, Scissors, Sparkles, Upload, X } from "lucide-react";
import { buildArticulatedCharacterPrompt, buildArticulatedPartsPrompt } from "@framebaker/shared";
import { api } from "../api";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { isVideoFile, useCropQueue } from "../hooks/useCropQueue";
import { type FileState, useImportWorkflow } from "../hooks/useImportWorkflow";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import CropModal from "./CropModal";
import PxSelect from "./PxSelect";
import PromptEnhancer from "./PromptEnhancer";
import ProviderModelPicker, { resolveProviderSelection } from "./ProviderModelPicker";
import SizePicker from "./SizePicker";
import ReferencePicker, { type ReferenceSelection } from "./ReferencePicker";
import GenBackgroundOption from "./GenBackgroundOption";

interface Props {
  initialTab: "upload" | "cli";
  /** 从素材操作入口拆分人物时，预选当前完整人物并直接进入骨骼分件流程。 */
  initialReferenceMaterialId?: string;
  /** 当前选中的素材文件夹（null = 未分组 / 全部） */
  folderId?: string | null;
  onClose: () => void;
  onDone: () => void;
}

function stateIcon(s: FileState): string {
  switch (s) {
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "uploading":
      return "↑";
    case "queued":
      return "…";
    default:
      return "·";
  }
}

/** 素材导入弹窗：上传（可多选，单图/GIF/MP4 混合）或 AI 生成，目标为 /api/materials/* */
export default function MaterialImportModal({ initialTab, initialReferenceMaterialId, folderId = null, onClose, onDone }: Props) {
  const t = useT();
  useModalEscClose(onClose);
  const [tab, setTab] = useState<"upload" | "cli">(initialTab);
  const [fps, setFps] = useState(8);
  const [autoMatting, setAutoMatting] = useState(true); // 默认勾选抠图去背
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [references, setReferences] = useState<ReferenceSelection[]>(() => initialReferenceMaterialId ? [{ kind: "material", id: initialReferenceMaterialId }] : []);
  const [flattenBackground, setFlattenBackground] = useState<string | undefined>();
  const [count, setCount] = useState(4);
  const [mediaKind, setMediaKind] = useState<"image" | "video">("image"); // 生成内容：图片 / 视频（抽帧另做）
  const [generationLine, setGenerationLine] = useState<"frame" | "skeletal">(initialReferenceMaterialId ? "skeletal" : "frame");
  const [skeletalMode, setSkeletalMode] = useState<"parts" | "decompose">(initialReferenceMaterialId ? "decompose" : "parts");
  const [gridRows, setGridRows] = useState(3);
  const [gridCols, setGridCols] = useState(4);
  const [cropDismissed, setCropDismissed] = useState(false); // 「是否需要剪裁」确认行已回答
  const fileRef = useRef<HTMLInputElement>(null);
  const cfg = useServerConfig();
  const providerSelection = resolveProviderSelection(cfg?.gen.providers ?? [], providerId, model, { videoOnly: mediaKind === "video", preferI2v: mediaKind === "video" && references.length > 0 });
  const hasProvider = !!providerSelection.providerId;
  const workflow = useImportWorkflow(onDone);
  const { items, finished, submitting, setSubmitting, updateItem, okCount, errCount } = workflow;

  // 剪裁队列：逐张剪裁 / 单张重裁（确认后 PNG 替换原文件并标 cropped）
  const crop = useCropQueue(items, (i, file) => updateItem(i, { file, cropped: true }));
  const imageCount = items.filter((it) => !isVideoFile(it.file)).length;

  const resetAll = workflow.reset;

  const hasVideo = items.some((it) => isVideoFile(it.file));

  // 上传 Tab：多选逐个分发——图片直接成素材（立即完成），GIF/MP4 走 job 队列
  const submitUpload = async () => {
    await workflow.submit(async (file) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("fps", String(fps));
      fd.append("autoMatting", String(autoMatting));
      if (folderId) fd.append("folderId", folderId);
      const r = await api.uploadMaterial(fd);
      if ("jobId" in r) {
        return { kind: "queued", jobId: r.jobId };
      }
      return { kind: "done" }; // 单图 → 直接生成 1 个素材
    });
  };

  // 生成 Tab：提交即关窗，进度与结果由右侧任务面板展示
  const submitGenerate = async () => {
    if (submitting || (generationLine === "frame" && !prompt.trim()) || (generationLine === "skeletal" && ((skeletalMode === "parts" && !prompt.trim()) || (skeletalMode === "decompose" && references.length === 0)))) return;
    setSubmitting(true);
    try {
      const providers = (cfg?.gen.providers ?? []).filter((p) => (mediaKind === "video" ? p.video : true));
      const sel = resolveProviderSelection(providers, providerId, model, {
        videoOnly: mediaKind === "video",
        preferI2v: mediaKind === "video" && references.length > 0,
      });
      const skeletalPrompt = buildArticulatedPartsPrompt(skeletalMode === "decompose"
        ? { reference: true, extra: prompt, rows: gridRows, cols: gridCols }
        : { reference: true, description: prompt, rows: gridRows, cols: gridCols });
      const completeCharacterPrompt = buildArticulatedCharacterPrompt({ description: prompt });
      const generatedName = prompt.trim().slice(0, 24) || t("skeletal.parts.autoName");
      const completeMaterialName = t("skeletal.generate.completeMaterialName", { name: generatedName });
      const partsMaterialName = t("skeletal.generate.partsMaterialName", { name: generatedName, count: gridRows * gridCols });
      await api.generateMaterial({
        prompt: generationLine === "skeletal" && skeletalMode === "parts" ? completeCharacterPrompt : generationLine === "skeletal" ? skeletalPrompt : prompt.trim(),
        count: generationLine === "skeletal" ? 1 : count,
        autoMatting: generationLine === "skeletal" && skeletalMode === "parts" ? false : autoMatting,
        ...sel,
        folderId,
        ...(generationLine === "skeletal" ? {
          intent: skeletalMode === "decompose" ? "skeletal-decompose" as const : "skeletal-character" as const,
          name: skeletalMode === "parts" ? completeMaterialName : partsMaterialName,
          ...(skeletalMode === "decompose" ? { gridRows, gridCols } : {}),
          ...(skeletalMode === "parts" ? { followUp: { prompt: skeletalPrompt, name: partsMaterialName, autoMatting, gridRows, gridCols } } : {}),
        } : { intent: mediaKind === "video" ? "frame-video" as const : "frame-image" as const }),
        ...(mediaKind === "video" ? { mediaKind: "video" as const } : {}),
        ...(size ? { size } : {}),
        ...(references.length ? { references } : {}),
        ...(references.length && flattenBackground ? { flattenBackground } : {}),
      });
      notify(
        generationLine === "skeletal" && skeletalMode === "parts"
          ? t("skeletal.generate.sequenceQueued")
          : mediaKind === "video"
          ? t("msg.queued_when_ready_open_in_materials_and_extract_frames")
          : t("msg.queued_track_progress_in_the_right_job_panel"),
        "info"
      );
      onDone();
      onClose();
    } catch (e) {
      notify(t("msg.submit_failed_msg", { msg: (e as Error).message }));
      setSubmitting(false);
    }
  };

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}  >
      <motion.div
        className="modal pixel-panel import-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{t("msg.add_materials")}</h2>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </div>

        <div className="import-tabs">
          <button type="button" className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => { setTab("upload"); resetAll(); }}>
            <Upload size={14} /> {t("msg.upload_files")}
          </button>
          <button type="button" className={`tab ${tab === "cli" ? "active" : ""}`} onClick={() => { setTab("cli"); resetAll(); }}>
            <Sparkles size={14} /> {t("msg.generate")}
          </button>
        </div>

        {tab === "upload" ? (
          <>
            <div className="form-row">
              <label>{t("msg.multi_select_png_jpg_1_material_each_gif_mp4_split_into")}</label>
              <div className="file-drop" onClick={() => !submitting && fileRef.current?.click()}>
                {items.length ? t("msg.n_files_selected_click_to_reselect", { n: items.length }) : t("msg.click_to_choose_files_multi_select")}
              </div>
              <input
                ref={fileRef}
                type="file"
                hidden
                multiple
                accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,image/*,video/mp4,image/gif"
                onChange={(e) => {
                  workflow.selectFiles(Array.from(e.target.files ?? []));
                  setCropDismissed(false);
                  e.target.value = "";
                }}
              />
            </div>

            {items.length > 0 && (
              <ul className="up-list">
                {items.map((it, i) => (
                  <li key={`${it.file.name}-${i}`} className="up-item">
                    <span className={`up-state ${it.state}`}>{stateIcon(it.state)}</span>
                    <span className="up-name" title={it.error ?? it.file.name}>
                      {it.file.name}
                    </span>
                    {it.cropped && <span className="up-cropped">{t("msg.cropped")}</span>}
                    <span className="up-size">{(it.file.size / 1024).toFixed(1)} KB</span>
                    {!isVideoFile(it.file) && !submitting && (
                      <IconBtn className="up-crop" title={t("msg.crop_this_image")} onClick={() => crop.startOne(i)}>
                        <Scissors size={12} />
                      </IconBtn>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {imageCount > 0 && !cropDismissed && !submitting && !finished && (
              <div className="crop-ask">
                <span>{t("msg.n_images_crop_before_import_gif_mp4_skipped", { n: imageCount })}</span>
                <button
                  type="button"
                  className="px-btn mini"
                  onClick={() => {
                    setCropDismissed(true);
                    crop.startAll();
                  }}
                >
                  <Scissors size={12} /> {t("msg.crop_one_by_one")}
                </button>
                <button type="button" className="px-btn mini" onClick={() => setCropDismissed(true)}>
                  {t("msg.no_import_as_is")}
                </button>
              </div>
            )}

            {hasVideo && (
              <div className="form-row">
                <label>{t("msg.video_extract_fps_fps_applies_to_all_videos", { fps })}</label>
                <input type="range" min={1} max={24} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
              </div>
            )}

            <MattingOption checked={autoMatting} onChange={setAutoMatting} />

            {finished && (
              <div className="up-summary">
                {t("msg.ok")} <span className="ok">{okCount}</span> / {t("msg.failed")} <span className={errCount ? "err" : ""}>{errCount}</span>
              </div>
            )}

            <div className="modal-actions">
              {finished ? (
                <button type="button" className="px-btn" onClick={onClose}>
                  {t("msg.done_close")}
                </button>
              ) : (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn accent"
                  disabled={items.length === 0 || submitting}
                  onClick={submitUpload}
                >
                  <Upload size={14} /> {submitting ? t("msg.uploading") : t("msg.upload_n_files", { n: items.length || "" })}
                </motion.button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="generation-line-tabs" role="tablist" aria-label={t("generation.line.title")}>
              <button type="button" role="tab" aria-selected={generationLine === "frame"} className={generationLine === "frame" ? "active" : ""} onClick={() => setGenerationLine("frame")}><Sparkles size={14} /> {t("generation.line.frame")}</button>
              <button type="button" role="tab" aria-selected={generationLine === "skeletal"} className={generationLine === "skeletal" ? "active" : ""} onClick={() => { setGenerationLine("skeletal"); setMediaKind("image"); setCount(1); }}><Bone size={14} /> {t("generation.line.skeletal")}</button>
            </div>
            {generationLine === "skeletal" && <div className="skeletal-parts-setup">
              <div className="hint">{t("skeletal.parts.generateHint")}</div>
              <div className="skeletal-mode-tabs" role="tablist" aria-label={t("skeletal.generate.modeTitle")}>
                <button type="button" role="tab" aria-selected={skeletalMode === "parts"} className={skeletalMode === "parts" ? "active" : ""} onClick={() => setSkeletalMode("parts")}>{t("skeletal.generate.fromDescription")}</button>
                <button type="button" role="tab" aria-selected={skeletalMode === "decompose"} className={skeletalMode === "decompose" ? "active" : ""} onClick={() => setSkeletalMode("decompose")}>{t("skeletal.generate.fromReference")}</button>
              </div>
              {skeletalMode === "decompose" && <div className="hint">{t("skeletal.generate.decomposeHint")}</div>}
              {skeletalMode === "parts" && <ol className="skeletal-generation-flow">
                <li><b>1</b><span><strong>{t("skeletal.generate.characterStage")}</strong><small>{t("skeletal.generate.characterStageHint")}</small></span></li>
                <li><b>2</b><span><strong>{t("skeletal.generate.partsStage")}</strong><small>{t("skeletal.generate.partsStageHint")}</small></span></li>
              </ol>}
              <div className="skeletal-grid-config">
                <div><strong>{t("skeletal.generate.gridTitle")}</strong><span>{t("skeletal.generate.gridHint")}</span></div>
                <label>{t("msg.cols")}<input className="px-input" type="number" min="1" max="8" value={gridCols} onChange={(event) => setGridCols(Math.max(1, Math.min(8, Math.floor(Number(event.target.value)) || 1)))} /></label>
                <span>×</span>
                <label>{t("msg.rows")}<input className="px-input" type="number" min="1" max="8" value={gridRows} onChange={(event) => setGridRows(Math.max(1, Math.min(8, Math.floor(Number(event.target.value)) || 1)))} /></label>
                <strong>{t("skeletal.generate.gridCount", { count: gridRows * gridCols })}</strong>
                {(gridRows !== 3 || gridCols !== 4) && <button type="button" className="px-btn" onClick={() => { setGridRows(3); setGridCols(4); }}>{t("skeletal.generate.useHumanoidDefault")}</button>}
              </div>
            </div>}
            {generationLine === "frame" && <div className="form-row">
              <label>{t("msg.generate_as")}</label>
              <PxSelect
                value={mediaKind}
                options={[
                  { value: "image", label: t("msg.images_one_by_one") },
                  ...(generationLine === "frame" ? [{ value: "video", label: t("msg.video_then_extract_in_materials") }] : []),
                ]}
                onChange={(v) => {
                  setMediaKind(v as "image" | "video");
                  setSize("");
                }}
              />
            </div>}
            <PromptEnhancer
              mediaKind={mediaKind}
              referenceImageCount={references.length}
              intent={generationLine === "skeletal" ? (skeletalMode === "decompose" ? "skeletal-decompose" : "skeletal-character") : undefined}
              label={generationLine === "skeletal" ? t(skeletalMode === "decompose" ? "skeletal.generate.extraPrompt" : "skeletal.generate.characterPrompt") : t("msg.prompt")}
              placeholder={generationLine === "skeletal" ? t(skeletalMode === "decompose" ? "skeletal.generate.extraPromptPlaceholder" : "skeletal.generate.characterPromptPlaceholder") : mediaKind === "video" ? t("msg.e_g_pixel_knight_running_right_looping") : t("msg.e_g_cloaked_slime_idle_breathing")}

              value={prompt}
              onChange={setPrompt}
            />
            {mediaKind === "image" && generationLine === "frame" && (
              <div className="form-row">
                <label>{t("msg.count_count", { count })}</label>
                <input type="range" min={1} max={16} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </div>
            )}
            {mediaKind === "video" && (
              <div className="hint">{t("msg.saves_video_only_open_the_material_later_and_extract_fra")}</div>
            )}

            {(generationLine === "frame" || skeletalMode === "decompose") && <ReferencePicker
              value={references}
              onChange={setReferences}
              showFrames={false}
              label={generationLine === "skeletal" ? t("skeletal.generate.referenceRequired") : undefined}
              description={generationLine === "skeletal" ? t("skeletal.generate.referenceDescription") : undefined}
            />}
            <GenBackgroundOption value={flattenBackground} onChange={setFlattenBackground} reference={references[0]} />

            {mediaKind === "video" && (
              <div className="hint">{t("msg.ref_image_bailian_happyhorse_i2v_r2v_as_first_ref_frame")}</div>
            )}
            {!hasProvider && <div className="hint warn">{t("msg.no_gen_provider_add_cli_api_providers_in_settings")}</div>}
            <section className="generation-advanced">
              <h3 className="generation-advanced-title">{t("skeletal.generate.advanced")}</h3>
              <div className="generation-advanced-content">
                <ProviderModelPicker
                  providerId={providerId}
                  model={model}
                  onProviderChange={setProviderId}
                  onModelChange={setModel}
                  videoOnly={mediaKind === "video"}
                  preferI2v={mediaKind === "video" && references.length > 0}
                />
                {mediaKind === "image" && <SizePicker providerId={providerId} value={size} onChange={setSize} />}
                {mediaKind === "video" && <SizePicker providerId={providerId} value={size} onChange={setSize} forVideo />}
                {mediaKind === "image" && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}
                <div className="hint">
                  {t("msg.configure_generation_in_settings_cli_openai_compatible_b")}{" "}
                  <code>FRAMEBAKER_GEN_CLI</code> {t("msg.fallback")}
                  <br />
                  {t("msg.cli_set_command_arg_names_no_placeholders_ref_images_nee")}
                  <br />
                  {t("msg.video_gen_cli_bailian_minimax_only_async_extract_frames")}
                </div>
              </div>
            </section>
            <div className="modal-actions">
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn accent"
                disabled={!hasProvider || submitting || (generationLine === "frame" && !prompt.trim()) || (generationLine === "skeletal" && ((skeletalMode === "parts" && !prompt.trim()) || (skeletalMode === "decompose" && references.length === 0)))}
                onClick={submitGenerate}
              >
                <Sparkles size={14} /> {t(generationLine === "skeletal" && skeletalMode === "parts" ? "skeletal.generate.startSequence" : "msg.start_generate")}
              </motion.button>
            </div>
          </>
        )}

        {/* 剪裁工具：逐张队列或单张重裁 */}
        <AnimatePresence>
          {crop.cropIndex != null && items[crop.cropIndex] && (
            <CropModal
              image={items[crop.cropIndex].file}
              title={items[crop.cropIndex].file.name}
              onConfirm={crop.confirm}
              onSkip={crop.skip}
              onConfirmAll={crop.applyRectToAll}
              onTrimAll={crop.trimAll}
              remaining={crop.total - 1}
              onClose={crop.cancel}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
