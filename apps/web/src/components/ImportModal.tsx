import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Package, Pencil, Scissors, Search, Sparkles, Upload, X } from "lucide-react";
import { SOURCE_COLORS } from "@framebaker/shared";
import { api, materialImageUrl, type Folder, type Material } from "../api";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { isVideoFile, useCropQueue } from "../hooks/useCropQueue";
import { type FileState, useImportWorkflow } from "../hooks/useImportWorkflow";
import { notify } from "../notice";
import { SOURCE_LABEL_KEYS } from "../sourceLabel";
import { themedSourceColor, useTheme } from "../theme";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import CropModal from "./CropModal";
import PxSelect from "./PxSelect";
import PromptEnhancer from "./PromptEnhancer";
import ProviderModelPicker, { resolveProviderSelection } from "./ProviderModelPicker";
import SizePicker from "./SizePicker";
import ReferencePicker, { type ReferenceSelection } from "./ReferencePicker";
import { useMaterialEditor } from "./MaterialEditor";
import GenBackgroundOption from "./GenBackgroundOption";

type Tab = "materials" | "upload" | "cli";

interface Props {
  projectId: string;
  axisId?: string;
  trackId?: string;
  startStepId?: string;
  targetIsPrimary?: boolean;
  onClose: () => void;
  onDone: () => void;
}

function inferType(f: File): "gif" | "mp4" | "image" {
  const ext = f.name.split(".").pop()?.toLowerCase();
  if (ext === "gif") return "gif";
  if (ext === "mp4" || ext === "mov" || ext === "webm") return "mp4";
  return "image";
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

export default function ImportModal({ projectId, axisId, trackId, startStepId, targetIsPrimary = true, onClose, onDone }: Props) {
  const t = useT();
  const openMaterialEditor = useMaterialEditor();
  useModalEscClose(onClose);
  const [tab, setTab] = useState<Tab>("materials");
  // 素材库 Tab：素材多选导入
  const [mats, setMats] = useState<Material[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState("all");
  const [matV, setMatV] = useState(0);
  const [pickedIds, setPickedIds] = useState<string[]>([]); // 数组保持点选顺序
  const pickAnchorRef = useRef<string | null>(null);
  const [matQuery, setMatQuery] = useState(""); // 素材搜索（name + prompt 本地过滤）
  // 上传 Tab：多文件逐个分发
  const [fps, setFps] = useState(8);
  const [autoMatting, setAutoMatting] = useState(true); // 默认勾选抠图去背
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [references, setReferences] = useState<ReferenceSelection[]>([]);
  const [flattenBackground, setFlattenBackground] = useState<string | undefined>();
  const [count, setCount] = useState(4);
  const [mediaKind, setMediaKind] = useState<"image" | "video">("image"); // 生成内容：图片 / 视频（抽帧另做）
  const [cropDismissed, setCropDismissed] = useState(false); // 「是否需要剪裁」确认行已回答
  const fileRef = useRef<HTMLInputElement>(null);
  const theme = useTheme();
  const cfg = useServerConfig();
  const workflow = useImportWorkflow(onDone);
  const { items, finished, submitting, setSubmitting, updateItem, okCount, errCount } = workflow;

  // 打开素材库 Tab 时加载素材列表
  useEffect(() => {
    if (tab === "materials" && mats === null) {
      api
        .listMaterials()
        .then((list) => {
          setMats(list);
          setMatV(Date.now());
        })
        .catch((e) => notify(t("msg.load_materials_failed_msg", { msg: (e as Error).message })));
      api.listFolders("material").then(setFolders).catch((e) => console.error(e));
    }
  }, [tab, mats]);

  // 剪裁队列：逐张剪裁 / 单张重裁（确认后 PNG 替换原文件并标 cropped）
  const crop = useCropQueue(items, (i, file) => updateItem(i, { file, cropped: true }));
  const imageCount = items.filter((it) => !isVideoFile(it.file)).length;

  const resetProgress = workflow.reset;

  // ---- 素材库 Tab ----
  // 目录 + 搜索过滤：不影响已选（隐藏的素材仍保留在 pickedIds）
  const q = matQuery.trim().toLowerCase();
  const filteredMats = (mats ?? []).filter((m) => {
    if (folderId === "ungrouped" ? m.folder_id !== null : folderId !== "all" && m.folder_id !== folderId) return false;
    if (!q) return true;
    const prompt = typeof m.metadata.prompt === "string" ? m.metadata.prompt : "";
    return m.name.toLowerCase().includes(q) || prompt.toLowerCase().includes(q);
  });
  const folderOptions = useMemo(() => {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const pathOf = (folder: Folder) => {
      const names = [folder.name];
      const seen = new Set([folder.id]);
      let parentId = folder.parent_id;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        names.unshift(parent.name);
        parentId = parent.parent_id;
      }
      return names.join(" / ");
    };
    return [
      { value: "all", label: t("msg.all") },
      { value: "ungrouped", label: t("msg.ungrouped") },
      ...folders.map((folder) => ({ value: folder.id, label: pathOf(folder) })),
    ];
  }, [folders, t]);
  const visibleIds = filteredMats.map((m) => m.id);
  const allVisiblePicked = visibleIds.length > 0 && visibleIds.every((id) => pickedIds.includes(id));

  const togglePick = (id: string, range: boolean) => {
    const anchor = pickAnchorRef.current;
    if (range && anchor) {
      const from = visibleIds.indexOf(anchor);
      const to = visibleIds.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        const rangeIds = visibleIds.slice(lo, hi + 1);
        setPickedIds((prev) => [...prev, ...rangeIds.filter((rangeId) => !prev.includes(rangeId))]);
        pickAnchorRef.current = id;
        return;
      }
    }
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((pickedId) => pickedId !== id) : [...prev, id]));
    pickAnchorRef.current = id;
  };

  const toggleVisible = () => {
    const visible = new Set(visibleIds);
    setPickedIds((prev) =>
      allVisiblePicked ? prev.filter((id) => !visible.has(id)) : [...prev, ...visibleIds.filter((id) => !prev.includes(id))]
    );
  };

  const submitPick = async () => {
    if (pickedIds.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api.batchImportMaterials(pickedIds, projectId, axisId && trackId ? { axisId, trackId, ...(startStepId ? { startStepId } : {}) } : undefined);
      onDone(); // 刷新帧列表（WS 也会广播 frames_changed）
      onClose();
    } catch (e) {
      notify(t("msg.import_failed_msg", { msg: (e as Error).message }));
      setSubmitting(false);
    }
  };

  // 跳转素材库（pushState + 手动派发 popstate，App 监听的是 popstate）
  const goMaterials = () => {
    history.pushState(null, "", "/materials");
    window.dispatchEvent(new PopStateEvent("popstate"));
    onClose();
  };

  // ---- 上传 Tab ----
  const hasVideo = items.some((it) => inferType(it.file) !== "image");

  const submitUpload = async () => {
    await workflow.submit(async (file) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("projectId", projectId);
      fd.append("type", inferType(file));
      fd.append("fps", String(fps));
      fd.append("autoMatting", String(autoMatting));
      const { jobId } = await api.upload(fd);
      return { kind: "queued", jobId };
    }, true);
  };

  // ---- 生成 Tab：提交即关窗，进度与结果由右侧任务面板展示 ----
  const submitGenerate = async () => {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    try {
      const providers = (cfg?.gen.providers ?? []).filter((p) => (mediaKind === "video" ? p.video : true));
      const sel = resolveProviderSelection(providers, providerId, model, {
        videoOnly: mediaKind === "video",
        preferI2v: mediaKind === "video" && references.length > 0,
      });
      await api.generate({
        projectId,
        prompt: prompt.trim(),
        count,
        autoMatting,
        ...sel,
        ...(mediaKind === "video" ? { mediaKind: "video" as const } : {}),
        ...(size ? { size } : {}),
        ...(references.length ? { references } : {}),
        ...(references.length && flattenBackground ? { flattenBackground } : {}),
      });
      notify(
        mediaKind === "video"
          ? t("msg.queued_video_saved_to_materials_extract_frames_when_read")
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
          <h2 style={{ flex: 1 }}>{t("msg.import_materials")}</h2>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </div>

        <div className="import-tabs">
          <button
            type="button"
            className={`tab ${tab === "materials" ? "active" : ""}`}
            onClick={() => {
              setTab("materials");
              resetProgress();
            }}
          >
            <Package size={14} /> {t("msg.materials")}
          </button>
          <button type="button" className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => { setTab("upload"); resetProgress(); }}>
            <Upload size={14} /> {t("msg.upload_files")}
          </button>
          <button type="button" className={`tab ${tab === "cli" ? "active" : ""}`} onClick={() => { setTab("cli"); resetProgress(); }}>
            <Sparkles size={14} /> {t("msg.generate")}
          </button>
        </div>
        {!targetIsPrimary && tab !== "materials" && <div className="up-summary">{t("timeline.asyncImportPrimaryHint")}</div>}

        {tab === "materials" && (
          <>
            {mats === null ? (
              <div className="empty">{t("msg.loading_materials")}</div>
            ) : mats.length === 0 ? (
              <div className="empty">
                <Package size={28} />
                <p>{t("msg.materials_empty_generate_or_upload_in_materials_first")}</p>
                <button type="button" className="px-btn accent" onClick={goMaterials}>
                  {t("msg.go_to_materials")}
                </button>
              </div>
            ) : (
              <>
                <div className="mat-filter-row">
                  <div className="mat-search">
                    <Search size={14} />
                    <input
                      className="px-input"
                      placeholder={t("msg.search_name_prompt")}
                      value={matQuery}
                      onChange={(e) => setMatQuery(e.target.value)}
                    />
                  </div>
                  <PxSelect
                    className="mat-folder-filter"
                    value={folderId}
                    options={folderOptions}
                    onChange={setFolderId}
                  />
                  <button type="button" className="px-btn" disabled={visibleIds.length === 0} onClick={toggleVisible}>
                    {allVisiblePicked ? t("msg.deselect_current_results") : t("msg.select_current_results")}
                  </button>
                </div>
                {filteredMats.length === 0 ? (
                  <div className="empty">{t(q ? "msg.no_matching_materials" : "msg.no_materials_in_this_folder")}</div>
                ) : (
                <div className="mat-pick-grid">
                  {filteredMats.map((m) => {
                    const picked = pickedIds.includes(m.id);
                    return (
                      <div
                        key={m.id}
                        className={`mat-pick ${picked ? "on" : ""}`}
                        title={m.name}
                        onClick={(event) => togglePick(m.id, event.shiftKey)}
                      >
                        <img src={materialImageUrl(m.id, matV, "processed", 256)} alt="" draggable={false} loading="lazy" decoding="async" />
                        <span className={`mat-dot ${m.status}`} title={m.status === "matted" ? t("msg.matted_431ee1") : t("msg.original")} />
                        <span
                          className="mat-src"
                          style={{ background: themedSourceColor(SOURCE_COLORS[m.source] ?? "#888", theme) }}
                        >
                          {t(SOURCE_LABEL_KEYS[m.source] ?? m.source)}
                        </span>
                        <span className={`mat-check ${picked ? "on" : ""}`}>{picked && <Check size={12} />}</span>
                        {m.kind !== "video" && (
                          <IconBtn
                            className="mat-pick-edit"
                            title={t("materialEdit.action")}
                            onClick={(event) => {
                              event.stopPropagation();
                              openMaterialEditor({
                                id: m.id,
                                name: m.name,
                                v: matV,
                                onSaved: () => {
                                  setMatV(Date.now());
                                  void api.listMaterials().then(setMats);
                                },
                              });
                            }}
                          >
                            <Pencil size={12} />
                          </IconBtn>
                        )}
                      </div>
                    );
                  })}
                </div>
                )}
                <div className="up-summary">
                  {t("msg.selected")} <span className="ok">{pickedIds.length}</span> {t("msg.materials_append_to_timeline_in_click_order")}
                </div>
                <div className="modal-actions">
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.95 }}
                    className="px-btn accent"
                    disabled={pickedIds.length === 0 || submitting}
                    onClick={submitPick}
                  >
                    <Package size={14} /> {submitting ? t("msg.importing") : t("msg.import_n_selected_materials", { n: pickedIds.length })}
                  </motion.button>
                </div>
              </>
            )}
          </>
        )}

        {tab === "upload" && (
          <>
            <div className="form-row">
              <label>{t("msg.multi_select_png_jpg_frames_gif_mp4_extract_by_extension")}</label>
              <div className="file-drop" onClick={() => !submitting && fileRef.current?.click()}>
                {items.length ? t("msg.n_files_selected_click_to_reselect", { n: items.length }) : t("msg.click_to_choose_files_multi_select")}
              </div>
              <input
                ref={fileRef}
                type="file"
                hidden
                multiple
                accept=".gif,.mp4,.mov,.webm,.png,.jpg,.jpeg,.webp,image/*,video/mp4,image/gif"
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
                <label>{t("msg.mp4_extract_fps_fps_applies_to_all_videos", { fps })}</label>
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
                  <Upload size={14} /> {submitting ? t("msg.uploading") : t("msg.import_n_files", { n: items.length })}
                </motion.button>
              )}
            </div>
          </>
        )}

        {tab === "cli" && (
          <>
            <div className="form-row">
              <label>{t("msg.generate_as")}</label>
              <PxSelect
                value={mediaKind}
                options={[
                  { value: "image", label: t("msg.images_frame_by_frame") },
                  { value: "video", label: t("msg.video_then_extract_in_materials") },
                ]}
                onChange={(v) => {
                  setMediaKind(v as "image" | "video");
                  setSize("");
                }}
              />
            </div>
            <PromptEnhancer
              mediaKind={mediaKind}
              referenceImageCount={references.length}
              label={t("msg.prompt")}
              placeholder={mediaKind === "video" ? t("msg.e_g_pixel_knight_running_right_looping") : t("msg.e_g_knight_with_sword_walk_cycle_right")}
              value={prompt}
              onChange={setPrompt}
            />
            {mediaKind === "image" ? (
              <div className="form-row">
                <label>{t("msg.frames_count", { count })}</label>
                <input type="range" min={1} max={16} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </div>
            ) : (
              <div className="hint">{t("msg.video_goes_to_materials_first_extract_frames_there_then")}</div>
            )}
            <ReferencePicker value={references} onChange={setReferences} showFrames projectId={projectId} />
            <GenBackgroundOption value={flattenBackground} onChange={setFlattenBackground} reference={references[0]} />
            {mediaKind === "video" && (
              <div className="hint">{t("msg.ref_image_bailian_happyhorse_i2v_r2v_as_first_ref_frame")}</div>
            )}
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
            <div className="modal-actions">
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                className="px-btn accent"
                disabled={!prompt.trim() || submitting}
                onClick={submitGenerate}
              >
                <Sparkles size={14} /> {t("msg.start_generate")}
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
