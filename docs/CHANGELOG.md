# FrameBaker Changelog

This document records features, changes, and bug fixes by release. Main releases use the SemVer-compatible `MAJOR.WEEK.BUG` policy documented in [VERSIONING.md](VERSIONING.md).

## [Unreleased]

## [0.5.0] - 2026-09-02

### Added

- Added worker-backed color-key matting for image materials with canvas eyedropper sampling, dominant-color palettes, 0–255 Chebyshev tolerance, optional edge softness, live preview, and single or batch application while preserving source images.
- Added optional solid reference backgrounds to all generation dialogs, with high-contrast presets, custom colors, palette-based recommendations, and temporary server-side ImageMagick flattening that never modifies source materials or frames.

### Removed

- Removed the target-skeleton selector from reference decomposition: it only influenced the generation prompt and grid rows/columns, downstream split, naming, and binding never consumed it, and `targetSkeletonId` was never accepted by the server; the split grid is back to manual rows/columns plus the humanoid default.

## [0.4.0] - 2026-08-20

### Added

- Added project-level character joint angle adjustments in the binding editor; per-bone base rotations persist with the character and apply consistently to the rest pose, every motion, and `.fbanim` exports without modifying shared skeleton assets.
- Added deterministic flexible attachment deformation with canvas Warp dragging, rest bend, playback sway, axis, frequency, and phase controls for capes and other soft parts.
- Added a full skeletal-parts sheet workflow with flexible per-cell crops, direct divider resizing, rectangular merges, right-click horizontal/vertical subdivision, quality-gated previews, and per-part erase editing before registration.
- Added connected-component auto-detection to the skeletal split modal: opaque parts are detected as individual cells (in reading order) so a uniform grid no longer cuts through a part, and each detected cell stays editable, splittable, mergeable, and renamable.
- Added shared-layer capabilities and tests for humanoid skeleton semantics diagnosis and auto-assembly (not yet wired into the UI).
- Added material-folder filtering to the skeletal binding image picker, including hierarchical folder paths plus All and Ungrouped views.
- Added material renaming from the library context menu, REST API, and MCP tool, with immediate open-view synchronization.
- Completed image-material context menus with direct crop, frame/skeletal split, character decomposition, multi-action/eight-direction generation, matting restore, import, layering, trim, export, and delete actions.
- Motion events can now accept, validate, display, and persist an optional JSON payload.
- Added MotionClip schema v2 with per-segment cubic-bezier timing, explicit lossless v1 migration, eased quaternion slerp, curve editing, and `.fbanim`/raster compatibility.
- Added freeform attachment warping: parts can enable a draggable control-point grid (2×2/3×3/4×4) for static deformation in the binding editor, and `att:` warp tracks animate the same grid deltas on the motion timeline; warped bitmaps are rasterized deterministically (nearest-neighbor) and compose ahead of the bend filter, with full `.fbanim` round-trip support.

### Changed

- Localized the built-in humanoid skeleton and its joint labels throughout skeleton selection, motion editing, canvas hints, timelines, and character binding while preserving custom names verbatim.
- Refined skeletal-parts prompts to treat the requested grid as capacity, allow transparent surplus cells and rectangular multi-cell blocks for oversized parts, and forbid invented filler parts or weapons.
- Limited divider dragging to the active cell and only the cells directly facing that edge, leaving lateral cells unchanged.
- Unified skeletal project output on the `.fbanim` runtime package and removed the frame-project compatibility bake path, RenderProfile, and RasterSequence APIs.

### Fixed

- Made the selected attachment's transform outline capture canvas drags, so overlapping parts cannot redirect a Warp or transform edit to another layer.
- Made erase strokes reach the exact image boundary when dragged outside the editor, and stopped near-transparent antialias residue from falsely triggering skeletal-part edge warnings.
- Fixed the skeletal project editor not reflecting animation-asset saves: the live preview canvas and the skeleton/binding views now subscribe to `animation_assets_changed` and refetch the current clip, skeleton, and asset list as soon as the motion editor (or any other page) persists changes.
## [0.3.1] - 2026-08-13

### Changed

- Split multi-image generation requests into independently scheduled jobs under the global queue concurrency limit, return all IDs through `jobIds` while preserving `jobId`, and refresh an open material library as each generated material completes.
- Changed all default action prompts to let idle, movement, attack, casting, hit, and defeat motions fit the referenced character's appearance, equipment, and abilities instead of assuming specific motions; explicit extra descriptions still specify the move.
- Video generation prompts (both prompt enhancement and default action videos) now require a slightly wider locked camera with about 15% safe margin on every edge, keeping the whole subject and its full motion trajectory inside the frame so limbs and props are never cropped at the boundary.

### Added

- Added independent track × step attack-effect cells—including empty image cells—with live composited tapered flame/energy/ink drawing, five deterministic slash/bristle/dry/spark/echo brush textures, an effect-only delete action, transform controls, cross-step copy/paste, playback, undo, and export baking across every animation axis.
- Added explicit animation export choices for independent PNG sequences and a single sprite sheet that automatically wraps into rows within browser canvas limits, both with frame metadata JSON.
- Added folder filtering, select-all for current results, and Shift range selection when importing materials into a project.
- Added quick character eight-view generation from an image material: a reference-locked 3×3 turnaround sheet laid out as 3 / 2 / 3 views around an empty center cell; grid split defaults to 3×3 and skips that center cell.

### Fixed

- Kept the canvas zoom and pan viewpoint stable while switching timeline steps or drawing effects; fitting now runs only on initial load, explicit fit, resize, or playback mode boundaries.
- Made sprite-sheet exports scan shared opaque content bounds, use a compact row-major grid, and composite through per-cell canvases so large sheets no longer contain huge transparent gaps or dropped middle frames.
- Refreshed the persistent job panel against server state whenever returning to the material library, recovering status updates missed while on another page.
- Strengthened the character eight-view generation prompt so every occupied 3×3 cell explicitly requires a distinct full-body heading instead of allowing the reference orientation to be repeated.
- Fixed grid split uploads failing validation because multipart JSON metadata was parsed into an object, and now surface the first per-cell upload error when every cell fails.
- Prevented the video frame picker workspace from overlapping its selection and submit areas on short desktop viewports, and made the `M` capture shortcut work after focusing timeline and button controls.

## [0.3.0] - 2026-08-12

### Added

- Added ordered multi-reference image selection (up to 10 mixed materials/project frames) across the web UI, REST API, MCP tools, queue, and provider adapters. OpenAI-compatible edits, DashScope, Gemini, DashScope r2v, and structured CLI providers now submit all references while single-image protocols reject unsupported combinations explicitly.
- Added an in-context model compatibility tip when multiple references are selected, and wrap asynchronous provider failures with actionable guidance while preserving the original provider error.
- Refined prompt enhancement with explicit subject/action/composition/style/continuity structure, conservative detail completion, prompt-injection-resistant input handling, and separate image/video guidance.
- Added a visual-prompt few-shot example plus automatic correction retry, preventing short descriptions such as character names from being returned as encyclopedia answers or clarification questions.
- Made prompt-enhancement examples follow the selected style and image/video mode, and clear stale comparisons when the style or enhancer changes.
- Pass the selected reference-image count into prompt enhancement so it can switch between text-to-generation, single-reference editing, and ordered Image 1…N multi-reference instructions.
- Added project-level Cmd/Ctrl+Z for successful frame and timeline edits, with per-project serialization, database-only snapshots for lightweight edits, file snapshots only when project images change, failure-safe restore, and a 50-entry history limit.

### Changed

- Added cached server-side frame/material thumbnails, conditional image responses with ETag and immutable versioned caching, lazy thumbnail loading, and editor-only Pixi loading through a locally hosted gzip bundle.
- Reduced timeline and live-update work by using indexed frame lookup maps and coalescing WebSocket-driven refreshes.
- Stage asynchronous generation and matting outputs before committing them to project storage; completed background jobs and MCP project mutations invalidate older undo history so stale snapshots cannot remove newer artifacts.

### Fixed

- Preserve the actual JPEG, WebP, GIF, or PNG MIME type when reference images are sent to generation providers instead of declaring every source as PNG.

## [0.2.6] - 2026-08-11

### Changed

- Automated the marker-delimited README “Latest Changes” sections from the two newest bilingual changelog releases during version bumps, and made version checks detect stale generated summaries.

### Fixed

- Hardened the dedicated Gemini image provider adapter to scan all candidates, diagnose prompt/output safety blocks and text-only refusals, include response IDs, tolerate proxy response casing, and retry one transient no-image result instead of reporting every HTTP 200 without `inlineData` as the same schema error.

## [0.2.5] - 2026-08-11

### Fixed

- Kept a timeline step in place when Delete/Backspace clears its selected frame cell; whole-step deletion now remains an explicit toolbar action only.

## [0.2.4] - 2026-08-11

### Added

- Added a reusable material image editor with a real-time eraser, undo/reset, 90° rotation, zoom, and panning. It is available from material details, context/selection actions, project material imports, and generation reference pickers; CPU-heavy replay and PNG encoding run through the imageops worker.

### Changed

- Standardized downstream material consumption to prefer valid matted output, including project imports and generation references; original images remain available only to explicit original/restore/rematting actions.

### Fixed

- Prevented the MCP end-to-end test from leaving `MCP测试` projects in the development database after each test run.
- Fixed reusable frame assets being rejected when dropped onto timeline cells because the target requested a move operation while the source allowed only copying.
- Made frame-asset and timeline-cell selection mutually exclusive, and added Delete/Backspace removal for the selected timeline cell without intercepting text inputs or dialogs.
- Prevented a late Pixi texture request for a deleted timeline frame from surfacing as an unhandled development error overlay.
- Allowed selected frame assets to be dropped onto a track header when no steps exist, automatically creating enough steps; dropping onto an existing cell continues filling from that step and appending any shortage.

## [0.2.3] - 2026-08-11

### Added

- Added the backward-compatible multi-axis, multi-track composited timeline foundation, canonical REST/MCP operations, and idempotent legacy-project migration.
- Added a canvas fit-to-window control with safer composition margins, Cmd/Ctrl+wheel canvas zoom in edit and playback, and changed the animation-axis picker to the shared pixel-style select.
- Added free frame-cell drag and drop within and across tracks; dropping on an occupied cell atomically swaps both frames, while locked tracks remain protected.
- Added ordered multi-selection placement that copies reusable frame assets into consecutive timeline cells through the REST API, MCP, and editor drag and drop.
- Changed project imports to enter a compact, tile-based unassigned frame pool on the left; frames are assembled by dragging them onto timeline cells, with replaced cells returned to the pool.
- Changed the left panel from a consuming queue into a persistent reusable frame-asset panel, and added Space+drag canvas panning with grab/grabbing feedback.
- Added visible in-editor usage guidance for dragging reusable assets onto timeline cells and for Space+drag canvas panning.

### Fixed

- Prevented batch timeline placement from mixing frames and tracks from different projects or partially changing the timeline when validation fails.
- Fixed job status recovery after WebSocket interruptions and prevented initial job loading from overwriting newer live events.
- Fixed stale material detail previews after background processing updates.

### Changed

- Changed playback controls into a draggable in-canvas overlay that no longer reserves or shrinks canvas space.
- Reduced material-grid and job-panel rerenders by batching live updates, applying per-item cache versions, and memoizing unchanged rows and cards.

## [0.2.2] - 2026-08-11

### Added

- Added standalone scene-layer model configuration and material-library actions with 1–4 layers and recursive decomposition.
- Added optional pre-matting that executes strictly as matting then scene decomposition within one job.
- Added synchronized version tooling and a README demonstration generated and decomposed through the real application.

### Fixed

- Prevented runtime `.length` crashes when legacy provider configuration omits model arrays.
- Removed the fake white “unmatted” comparison pane when a material only has a raw image.
- Preserved raw/matted images and metadata in grid-split material outputs.
- Relabeled scene-layer outputs from generic “API” to “Layers”, including migration of existing outputs.

### Changed

- Moved scene-layer configuration out of generation providers into a standalone setting.
- Unified the per-request layer range to 1–4 after testing the current Gitee endpoint.
- Changed the image-layer UI and MCP inference-step default from 20 to the upstream quality setting of 50; CFG remains 4.
- Reframed “Element layers” as “Scene layers”, added an explicit whole-subject/props/background scope, and disabled pre-matting by default to preserve scene context.
- Added a generated, real four-layer scene-decomposition demonstration to the README and documented why scene layers are not character rig parts.
- Adopted the `MAJOR.WEEK.BUG` main-release policy and added `bug`, `week`, and `major` version-script targets.

## [0.1.0] - 2026-08-11

### Added

- Initial Bun full-stack frame-animation editor with projects, material library, timeline, PixiJS editing, playback preview, and sprite-sheet export.
- Image/GIF/video import, timestamp extraction, multi-provider image and video generation, rembg matting, and background jobs.
- Cassette Futurism light/dark themes, resizable editor layout, frame batch operations, and WebSocket live synchronization.
- Worker-backed material cropping and transparent-edge detection, batch crop queues, grid splitting, material search, and ZIP export.
- Reference-image generation, DashScope/Gemini/MiniMax providers, prompt enhancement, structured CLI configuration, and model capability grouping.
- Video materials, custom playback, point/range extraction, multi-action generation, folders, internationalization, and language switching.
- Windows/uv and CPU/GPU rembg setup, provider diagnostics, transform baking, and individual-material exports.
- MCP Streamable HTTP server plus bilingual UI, API, architecture, and user documentation.

### Fixed

- Fixed preview overflow, Pixi canvas frame playback, job-panel positioning, and themed replacements for native selectors.
- Fixed Gemini/MiniMax prompt-enhancer compatibility, legacy model linking, Windows environment behavior, and provider configuration issues.
- Fixed deletion/cancellation, forced material import, and serial multi-file ordering when polling fails.

### Engineering and Documentation

- Added core unit tests, coverage reporting, and GitHub Actions typecheck/test CI.
- Expanded bilingual READMEs, user guide, architecture/API/roadmap docs, demo media, and MIT licensing.
