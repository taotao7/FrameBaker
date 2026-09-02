import { useEffect, useRef, useState } from "react";
import { Pipette } from "lucide-react";
import { frameImageUrl, materialImageUrl } from "../api";
import { useT } from "../i18n";
import { palette } from "../imageops/client";
import type { RgbColor } from "../imageops/ops";
import { notify } from "../notice";
import type { ReferenceSelection } from "./ReferencePicker";

export const GEN_BACKGROUND_PRESETS = ["#FF00FF", "#00FF00", "#00FFFF", "#FFFFFF", "#000000"] as const;
const STORAGE_KEY = "framebaker-gen-background";

export function readRememberedGenBackground(): string | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

const remember = (color: string) => {
  try {
    localStorage.setItem(STORAGE_KEY, color);
  } catch {
    // 隐私模式或存储被禁用时仍允许本次使用。
  }
};

const toRgb = (hex: string): RgbColor => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const chebyshev = (left: RgbColor, right: RgbColor) => Math.max(
  Math.abs(left[0] - right[0]),
  Math.abs(left[1] - right[1]),
  Math.abs(left[2] - right[2]),
);

/** 选择与全部主色的最近距离仍最大的预设色，避免只远离某一个局部颜色。 */
function recommendPreset(colors: RgbColor[]): string {
  if (!colors.length) return GEN_BACKGROUND_PRESETS[0];
  let best: string = GEN_BACKGROUND_PRESETS[0];
  let bestDistance = -1;
  for (const preset of GEN_BACKGROUND_PRESETS) {
    const candidate = toRgb(preset);
    const distance = Math.min(...colors.map((color) => chebyshev(candidate, color)));
    if (distance > bestDistance) {
      best = preset;
      bestDistance = distance;
    }
  }
  return best;
}

interface Props {
  /** undefined = 关闭；#RRGGBB = 开启并使用该颜色。 */
  value?: string;
  onChange: (value: string | undefined) => void;
  reference?: ReferenceSelection;
  version?: number;
  /** 已抠图动作素材首次打开时自动推荐；手动记忆色优先时不传。 */
  autoRecommend?: boolean;
}

/** 生成引用图临时垫底选项；取主色走 imageops worker，不修改源素材。 */
export default function GenBackgroundOption({ value, onChange, reference, version, autoRecommend = false }: Props) {
  const t = useT();
  const [color, setColor] = useState(() => value ?? readRememberedGenBackground() ?? GEN_BACKGROUND_PRESETS[0]);
  const [recommending, setRecommending] = useState(false);
  const autoRecommended = useRef(false);

  useEffect(() => {
    if (value) setColor(value.toUpperCase());
  }, [value]);

  const selectColor = (next: string) => {
    const normalized = next.toUpperCase();
    setColor(normalized);
    remember(normalized);
    if (value) onChange(normalized);
  };

  const recommend = async () => {
    if (!reference || recommending) return;
    setRecommending(true);
    try {
      const url = reference.kind === "material"
        ? materialImageUrl(reference.id, version, "processed")
        : frameImageUrl(reference.id, version);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = recommendPreset(await palette(await response.blob(), 8));
      setColor(next);
      onChange(next);
    } catch (error) {
      notify(t("genBackground.recommendFailed", { msg: (error as Error).message }));
    } finally {
      setRecommending(false);
    }
  };

  useEffect(() => {
    if (!autoRecommend || !value || !reference || autoRecommended.current) return;
    autoRecommended.current = true;
    void recommend();
  }, [autoRecommend, reference, value]);

  const enabled = Boolean(value && reference);
  return (
    <section className={`gen-background-option${enabled ? " enabled" : ""}`}>
      <label className="px-check gen-background-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!reference}
          onChange={(event) => onChange(event.target.checked ? color : undefined)}
        />
        <span><strong>{t("genBackground.title")}</strong><small>{t("genBackground.sourceHint")}</small></span>
      </label>
      {!reference && <div className="hint">{t("genBackground.noReference")}</div>}
      {enabled && (
        <div className="gen-background-controls">
          <div className="gen-background-swatches">
            {GEN_BACKGROUND_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={color === preset ? "active" : ""}
                style={{ backgroundColor: preset }}
                title={preset}
                aria-label={preset}
                onClick={() => selectColor(preset)}
              />
            ))}
          </div>
          <label className="gen-background-custom">
            <span>{t("genBackground.custom")}</span>
            <input type="color" value={color} onChange={(event) => selectColor(event.target.value)} />
            <code>{color}</code>
          </label>
          <button type="button" className="px-btn mini" disabled={recommending} onClick={() => void recommend()}>
            <Pipette size={13} /> {recommending ? t("genBackground.recommending") : t("genBackground.recommend")}
          </button>
        </div>
      )}
    </section>
  );
}
