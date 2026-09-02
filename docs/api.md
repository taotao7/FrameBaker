# FrameBaker API

Base URL: `http://localhost:3000`; unless noted otherwise, all endpoints use the `/api` prefix. Request/response type definitions in `packages/shared/src/types.ts`.

Conventions:

- All ids are UUID strings
- Frame `tags` / `metadata` are parsed as JSON in API output (stored as strings in DB)
- Error responses: non-2xx + plain text error message
- Write operations trigger WS broadcast (`/ws`, message format `{ "type": string, "payload": any }`, types listed at the end)

## Projects

### GET /api/projects

Project list, sorted by creation time descending. `has_thumbnail` reflects whether a project thumbnail PNG exists (see below).

```json
{
  "projects": [
    { "id": "…", "name": "走路循环", "created_at": 1785912000000, "frame_count": 8, "first_frame_id": "…", "has_thumbnail": false }
  ]
}
```

### POST /api/projects

```json
// Request
{ "name": "走路循环" }
// Response
{ "id": "…", "name": "走路循环" }
```

### GET /api/projects/:id

```json
{ "project": { "id": "…", "name": "…", "created_at": 1785912000000, "frame_count": 8, "has_thumbnail": false } }
```

### PUT /api/projects/:id/thumbnail

Uploads a project thumbnail rendered by the frontend. Body is the raw PNG binary (`Content-Type: image/png`, max 2 MB; PNG magic bytes are validated). Stored at `storage/thumbnails/projects/<id>.png`. 404 if the project does not exist → `{ "ok": true }`.

### GET /api/projects/:id/thumbnail

Returns the stored PNG (`Content-Type: image/png`, ETag/Last-Modified supported); 404 when the project or its thumbnail does not exist. Append `?v=<timestamp>` to bust caches after an update.

### PATCH /api/projects/:id

`{ "name": "New Name" }` → `{ "ok": true }`

### DELETE /api/projects/:id

Deletes the project and all its frames, jobs, and disk files (including the project thumbnail) → `{ "ok": true }`, broadcasts `project_deleted`.

## Frames

### GET /api/projects/:id/frames

Returns frames sorted by `idx` ascending:

Compatibility view: this returns only the default axis primary track, ordered by canonical shared steps. `track_id` and `step_id` are included. Step `idx`/`duration` are authoritative; frame fields mirror them.

```json
{
  "frames": [
    {
      "id": "…", "project_id": "…", "idx": 0,
      "raw_path": "/abs/path/storage/projects/…/raw/frame_0000.png",
      "processed_path": null,
      "status": "ready", "duration": 1, "is_keyframe": 0,
      "offset_x": 0, "offset_y": 0, "scale": 1, "rotation": 0, "opacity": 1,
      "tags": [], "source": "gif", "metadata": {}
    }
  ]
}
```

### GET /api/frames/:id/image?type=raw|processed&size=64..1024&v=VERSION

PNG image stream. `type=processed` falls back to raw when no processed file exists. The optional integer `size` returns a cached thumbnail whose width and height are each at most that value; invalid or out-of-range values return the original image. Thumbnail generation uses ImageMagick or ffmpeg and gracefully falls back to the original image when neither is available. Responses include `ETag` / `Last-Modified`; URLs with `v` use a one-year immutable cache, while unversioned URLs revalidate. 404: frame or file not found.

### PATCH /api/frames/:id

Updatable fields (at least one required, all optional): `offset_x` / `offset_y` (-100000–100000), `scale` (0.1–8), `rotation` (radians, -π–π), `opacity` (0–1), `duration` (int 1–600), `is_keyframe` (0/1), and `tags` (string[]). Attack effects are independent timeline cells and use the endpoints below rather than frame patches.

```json
// Request
{ "offset_x": 12.5, "duration": 3, "is_keyframe": 1 }
// Response
{ "frame": { /* updated full frame */ } }
```

Broadcasts `frame_updated`.

### POST /api/frames/:id/replace

multipart/form-data: `file` (PNG, server validates file signature). The editor first crops/encodes via CropModal, then writes to `processed/<id>_replaced.png`; old processed file is cleaned up, `source` set to `upload`, status set to `ready`. Response `{ "frame": {…} }`, broadcasts `frame_updated`.

### POST /api/frames/:id/duplicate?count=N

Duplicates N copies (1–16, default 1) inserted after the original, copies image files and all properties, `source=duplicate`, subsequent frame indices shifted. Response `{ "ok": true, "count": 2 }`, broadcasts `frames_changed`.

### DELETE /api/frames/:id

Deletes frame and image files; subsequent frames in the same project have their idx decremented. `{ "ok": true }`, broadcasts `frames_changed`.

## Canonical composited timeline

- `GET /api/projects/:id/timeline?axisId=` — all project axes plus the selected/default axis, ordered tracks, shared steps, image `frames`, independent attack-effect `effects`, unassigned `poolFrames`, and reusable left-panel `assetFrames`.
- `POST /api/projects/:id/axes` (`name`, optional `fps`); `PATCH /api/axes/:id`; `DELETE /api/axes/:id` (the sole axis is protected).
- `POST /api/axes/:id/tracks`; `PATCH|DELETE /api/tracks/:id`; `POST /api/axes/:id/tracks/reorder` with exact unique `trackIds`. The primary/sole track is protected.
- `POST /api/axes/:id/steps`; `PATCH|DELETE /api/steps/:id`; `POST /api/axes/:id/steps/reorder` with exact unique `stepIds`. Step duration is 1–600 ticks and is mirrored to every cell.
- `PATCH /api/frames/:id/placement` with `{ "trackId", "stepId", "swap"?, "copy"? }`. Timeline moves use the existing frame; left-panel assembly uses `copy: true` to create an instance while keeping the source asset visible and reusable. With `swap: true`, an occupied target returns to the asset panel.
- `DELETE /api/frames/:id/placement` clears one timeline cell without deleting reusable image files. Asset frames return to the asset panel; copied timeline instances are discarded.
- `POST /api/tracks/:id/place-frames` with `{ "frameIds": [...], "startStepId"? }` copies same-project frame assets into consecutive cells on the target track. Occupied cells return to the asset panel, and missing trailing steps are appended atomically. Cross-project and non-asset sources are rejected before the timeline changes.
- `PUT /api/tracks/:id/steps/:stepId/effect` creates or replaces the effect in any track × step cell, including a cell with no image. The body contains up to 128 strokes; each stroke stores a `#RRGGBB` color, size 1–256, optional deterministic texture `brush` (`slash`, `bristle`, `dry`, `spark`, or `echo`; defaults to `slash`), and up to 4096 `{x,y,pressure}` points, plus independent offset/scale/rotation/opacity and optional `style` (`flame`, `energy`, or `ink`). `DELETE` on the same URL clears only the effect and leaves an image in the same cell untouched.

Timeline mutations broadcast `timeline_changed` with `projectId` and relevant axis/track/step/frame IDs. Deleting a cell prunes its step only when empty. Legacy duplication inserts shared steps after the source; legacy reorder is accepted only for an unambiguous primary-track one-cell-per-step shape.

- `POST /api/projects/:id/undo` restores the most recent successful timeline/frame edit for the project. The server keeps up to 50 per-project snapshots. Database-only edits do not copy image files; operations that replace, delete, duplicate, or import project images also snapshot the project files. Same-project edits and undo requests are serialized, and a failed restore rolls back without consuming the snapshot. Completed asynchronous jobs and MCP project mutations clear older history so stale snapshots cannot overwrite newer artifacts. A successful restore broadcasts `timeline_changed` and `frames_changed`; a project with no undo history returns 404.

### POST /api/projects/:id/reorder

```json
// Request: must contain exactly all frame ids of the project
{ "frameIds": ["id3", "id1", "id2"] }
// Response
{ "ok": true }
```

Rewrites idx by array order (transaction). 400: set mismatch. Broadcasts `frames_reordered`.

## Import

### POST /api/import/upload

multipart/form-data:

| Field | Description |
| --- | --- |
| `file` | Source file |
| `projectId` | Target project |
| `type` | `gif` (all frames) / `mp4` (extract at fps) / `image` (single image → one frame) |
| `fps` | Optional, mp4 extraction fps, default 8 (1–60) |
| `autoMatting` | Optional, `"true"` to auto-queue matting for each frame |

Response `{ "jobId": "…" }`, then poll `GET /api/jobs/:id` or wait for WS `job_done`.

```bash
curl -F "file=@test.gif" -F "projectId=$PID" -F "type=gif" http://localhost:3000/api/import/upload
```

### POST /api/import/generate

```json
// Request
{ "projectId": "…", "prompt": "pixel art knight", "count": 4, "autoMatting": false, "providerId": "…", "model": "wanx2.1-image", "size": "1328*1328", "references": [{ "kind": "material", "id": "…" }, { "kind": "frame", "id": "…" }], "mediaKind": "image" }
// Response
{ "jobId": "…", "jobIds": ["…", "…", "…", "…"] }
```

Provider resolution: if `providerId` is passed, looks up by id (not found → 400); default uses the first fully configured provider (settings page can configure multiple coexisting providers, types: `cli` / `api` (OpenAI-compatible) / `dashscope` (DashScope native) / `gemini` (banana) / `minimax`; when list is empty, env `FRAMEBAKER_GEN_CLI` synthesizes an id=`env` CLI provider as fallback). Optional `size` overrides the provider's `apiSize` at generation time (format varies by provider type: api e.g., `1024x1024`, dashscope e.g., `1328*1328`, gemini/minimax e.g., `16:9`; preset tiers in shared constant `GEN_SIZE_PRESETS`; CLI providers ignore size).

- **CLI provider**: structured fields assemble argv (`cliBin` + parameter name mappings: `cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`, empty = positional arg or not sent), no shell. For multiple references, `cliReferenceArg path` is repeated in selection order. Env `FRAMEBAKER_GEN_CLI` and legacy data use the legacy template placeholders (`{prompt}` `{output}` `{index}` `{reference}` `{model}`) and therefore support only one reference.
- **API provider (OpenAI-compatible, incl. OpenAI official / VolcEngine Doubao Seedream / various gateways)**: no reference image → `POST {apiBaseUrl}/images/generations` (JSON `{ model, prompt, size?, n: 1 }`); with references → `POST {apiBaseUrl}/images/edits` (multipart uses `image` for one file and repeated `image[]` for multiple files, plus prompt/model/size; requires an edits-capable model e.g., gpt-image series; dall-e-3 doesn't support edits). Response takes `data[0].b64_json` or `data[0].url` to download.
- **DashScope provider (native)**: `POST {apiBaseUrl}/api/v1/services/aigc/multimodal-generation/generation` (wan2.7-image / qwen-image etc., not in compatible mode); no reference image content is `[{text}]` only; each reference prepends one `{image: dataURI}` item in selection order. Response takes `output.choices[0].message.content[*].image` URL to download (24h valid). `apiSize` can be `2K`/`1K`/`4K` or star format (e.g., `2048*2048`) passed through as-is. **Base URL normalization** (`normalizeDashscopeBaseUrl`): accepts Token Plan `https://token-plan.cn-beijing.maas.aliyuncs.com`, or docs-style compatible address `…/compatible-mode/v1` / trailing `/api/v1` (server strips suffix then appends native path); pay-as-you-go commonly uses `https://dashscope.aliyuncs.com`.
- **Gemini provider (banana / nano-banana)**: `POST {apiBaseUrl}/v1beta/models/{model}:generateContent` (`x-goog-api-key` header); each reference is sent as an ordered `{inlineData: {mimeType,data}}` part before the text part; `apiSize` maps to `imageConfig.aspectRatio` (e.g., `16:9`). The adapter searches every candidate/part for `inlineData.data` (and tolerates proxy `inline_data`), reports `promptFeedback.blockReason`, candidate `finishReason`, safety categories, model refusal text, and `responseId` when HTTP 200 contains no image, and retries once only for `NO_IMAGE`, `IMAGE_OTHER`, or a transient empty-candidate response.
- **MiniMax provider**: `POST {apiBaseUrl}/v1/image_generation` (Bearer); reference image via `subject_reference` (subject feature preservation, one image limit, base64 dataURI); `apiSize` maps to `aspect_ratio` (e.g., `16:9`); `response_format=base64`, response takes `data.image_base64[0]`; `base_resp.status_code` non-0 = failure.

Model defaults to request's `model`, then first item in provider's model list; neither available = job error. Provider not found or unconfigured = job set to `error` with explanation. `count` 1–16. In image mode, each requested output is queued as an independent job and runs under the global queue concurrency limit; `jobId` remains the first ID for compatibility and `jobIds` contains the full batch.

- **Video mode**: `mediaKind: "video"` — only generates and saves a single video material (`raw.mp4`, no frame extraction; `count`/`fps` ignored). Only supported by CLI / DashScope / MiniMax. After completion, use `POST /api/materials/:id/extract` (fps or timestamps) to extract frames.

- **CLI provider**: `{output}` given `.mp4` suffix path; output detected as video by magic bytes (ftyp/EBML/RIFF-AVI) → ffmpeg frame extraction. **In image mode, CLI output that is actually video also auto-converts to frame extraction** (`count` ignored in this case).
- **MiniMax provider**: protocol by model — `MiniMax-Hailuo-*` / `T2V-*` use v1: `POST {apiBaseUrl}/v1/video_generation` (`{ model, prompt, duration? }`) → `task_id`; poll `GET {apiBaseUrl}/v1/query/video_generation?task_id=` (`status`: Success/Fail etc.) to get `file_id`, then `GET {apiBaseUrl}/v1/files/retrieve?file_id=` to get `download_url`. `MiniMax-H3` etc. use v2: `POST {apiBaseUrl}/v2/video_generation` (`{ model, content:[{type:"text",text}], duration, ratio? }`) → `task_id`; poll `GET {apiBaseUrl}/v2/query/video_generation/{task_id}` (`task.status`: succeeded/failed/cancelled), success takes `task.content.url` to download. Default `duration=6`; text-to-video defaults to `ratio=16:9`.
- **DashScope provider (Wanxiang / HappyHorse)**: `POST {apiBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis` (header `X-DashScope-Async: enable`). Text-to-video `happyhorse-1.1-t2v`: `input:{prompt}` + `parameters:{resolution,ratio,duration,watermark:false}`; image-to-video `*-i2v`: exactly one `input.media[{type:first_frame,url}]`; reference-to-video `*-r2v`: one ordered `{type:reference_image}` media item per reference. → `output.task_id`; poll `GET {apiBaseUrl}/api/v1/tasks/{task_id}` (`output.task_status`: PENDING/RUNNING/SUCCEEDED/FAILED), success takes `output.video_url` to download. Legacy wanx can pass `apiSize` as `size`.

Video is async (approximately 1–5 minutes); progress is written to `job.progress` and pushed via WS. DashScope i2v accepts one reference and r2v accepts multiple; MiniMax video rejects references rather than silently ignoring them. CLI behavior depends on its configured argument.

Reference images are passed as an ordered `references` array (maximum 10): `{ "kind": "material" | "frame", "id": "…" }`. Sources can be mixed. The server resolves every id to a file path (prefers processed, falls back to raw), preventing client path injection. Legacy `referenceMaterialId` / `referenceFrameId` remain supported for one image but cannot be combined with `references`. OpenAI-compatible, DashScope, and Gemini image protocols support multiple references; MiniMax and legacy CLI templates explicitly reject more than one.

Optional `flattenBackground` must be a `#RRGGBB` color and only takes effect when at least one reference image is present. Before invoking the provider, the server uses ImageMagick to temporarily flatten every resolved reference onto that solid background in `storage/staging/genbg_*`; source materials/frames are never modified, and the staging directory is removed after completion, failure, or cancellation. If ImageMagick is unavailable, generation continues with the original references and the completed job retains a background-flattening warning in `job.progress`.

## Material Library /api/materials

Materials are first generated/uploaded to the library, matted, compared, then imported to a project as frames. Material `source` semantics are the same as frames (`cli`/`api`/`dashscope`/`gemini`/`minimax`/`upload`/`gif`/`mp4`/`image`/`duplicate`; AI generation writes actual provider type, no longer always `cli`); `status` is `raw` (original) / `matted` (background removed). Both materials and projects can have a `folder_id` (see `/api/folders`).

### GET /api/materials

```json
{
  "materials": [
    {
      "id": "…", "name": "slime #1", "status": "matted", "source": "cli",
      "raw_path": "/abs/storage/materials/…/raw.png",
      "processed_path": "/abs/storage/materials/…/processed.png",
      "metadata": { "prompt": "pixel slime" }, "created_at": 1785912000000
    }
  ]
}
```

### PATCH /api/materials/:id

Rename one image or video material. Request `{ "name": "New material name" }` (trimmed, 1–200 characters) → `{ "material": {…} }`. Returns 404 when the material does not exist and broadcasts `material_updated` on success.

### GET /api/materials/:id/image?type=raw|processed&size=64..1024&v=VERSION

Material image/video stream. `type=processed` falls back to raw when no processed file exists. For image materials, the optional integer `size` returns a cached thumbnail whose width and height are each at most that value; invalid or out-of-range values return the original image. Thumbnail generation uses ImageMagick or ffmpeg and gracefully falls back to the original image when neither is available. Responses include `ETag` / `Last-Modified`; URLs with `v` use a one-year immutable cache, while unversioned URLs revalidate. Video responses ignore `size`.

### POST /api/materials/upload

multipart/form-data: `file` + optional `processedFile`, `metadata` (JSON object string; Elysia's multipart object parsing is also accepted), `autoMatting` (`"true"`), and `fps` (video extraction, default 8). `processedFile` creates a material with both raw/processed slots and `status=matted`; grid splitting uses it to preserve real before/after pairs.
PNG/JPG single image → directly creates 1 material, response `{ "materialId": "…" }`; GIF/MP4 → queued frame extraction, one material per frame, response `{ "jobId": "…" }`.

```bash
curl -F "file=@slime.png" http://localhost:3000/api/materials/upload
curl -F "file=@walk.gif" -F "autoMatting=true" http://localhost:3000/api/materials/upload
```

### POST /api/materials/generate

`{ "prompt": "pixel slime", "count": 4, "autoMatting": false, "references": [{ "kind": "material", "id": "…" }], "flattenBackground": "#FF00FF" }` → `{ "jobId": "…", "jobIds": ["…", "…", "…", "…"] }` (provider resolution, independent image jobs, multi-reference rules, and temporary `flattenBackground` handling are the same as `/api/import/generate`). Each completed material job broadcasts `materials_changed`, so an open material library refreshes incrementally. Optional `name`: material naming base (defaults to first 24 chars of prompt); output named `name #i` (count>1) — material detail "multi-action generation" passes "materialName_action". Supports `mediaKind: "video"`: only generates and saves video material (`kind=video`), **no frame extraction**; use the extract endpoint below to split into frames. Skeletal part generation accepts paired `gridRows` / `gridCols` values from 1–8; both generated metadata and the grid-split editor preserve them. The humanoid default is `gridRows: 3`, `gridCols: 4` (12 parts). A `skeletal-character` two-stage request may put the same fields inside `followUp` for its generated parts sheet. Skeletal requests no longer need a pre-created `characterPartSetId`: when omitted, the server creates the internal part set automatically and returns its ID alongside `jobId`; an explicit ID remains supported for API compatibility.

### POST /api/materials/:id/extract

Extract video/GIF material frames into individual image materials → `{ "jobId": "…" }`. Copies source file to staging then enqueues **one** `extract_frames` job; output named "originalName #i", defaults to same folder. Non-video/GIF returns 400.

- **Full-range by fps** (default, GIF/video): `{ "fps"?: 8, "autoMatting"?: false, "folderId"?: null }`
- **Point extraction** (video only): `{ "timestamps": [0.12, 0.5, 1.0], "autoMatting"?: false, "folderId"?: null }` — seconds (float), sorted and deduplicated, max 64; GIF with timestamps returns 400. Server runs one `ffmpeg -ss T -i … -frames:v 1` per timestamp (cancellable).

### POST /api/materials/:id/matting

Queues matting job (`matting` job, queue concurrency 2), response `{ "jobId": "…" }`; material not found → 404, missing raw file → 400. **Same material with existing queued/running matting job → 409** (prevents duplicate queueing). Engine detection order see `GET /api/config` — custom CLI → bundled rembg → PATH rembg → passthrough copy (passthrough warning written to `job.progress`). On completion, `status` set to `matted` and broadcasts `material_updated`; rembg model auto-downloads on first use (can be hundreds of MB), progress pushed via WS `job_*` events.

### POST /api/materials/batch-matting

`{ "ids": ["…", "…"] }` → `{ "ok": true, "count": 2, "skipped": 1 }`. Only queues matting for `status=raw` materials; already matted or **with active matting job** counted as `skipped` (detail page can still re-mat individually, but active job returns 409).

### POST /api/materials/:id/replace-image

multipart/form-data: `file` (PNG) + `slot` (`"raw"` | `"processed"`). Crop tool's save endpoint: overwrites the corresponding slot file; `slot=processed` when no processed exists creates one and sets `status=matted`; `slot=raw` doesn't affect existing processed. Response `{ "material": {…} }`, broadcasts `material_updated`.

### POST /api/materials/:id/unmatting

Deletes processed, restores to `raw` status. Response `{ "material": {…} }`.

### POST /api/materials/:id/import

```json
// Request
{ "projectId": "…", "count": 2 }
// Response
{ "ok": true, "count": 2, "frameIds": ["…", "…"] }
```

Copies material as unassigned project frame(s) into the left-side frame pool. When a material has a valid matted image, all imported frame image slots use that matted result so downstream operations cannot silently revert to the original; otherwise they use the raw image. The material library still retains the original for explicit compare, restore, rematting, and raw-export actions. Frames enter a timeline only after placement. `source` and metadata are preserved. `count` 1–16, default 1. Broadcasts `frames_changed`.

### POST /api/materials/batch-delete

`{ "ids": ["…", "…"] }` → `{ "ok": true, "deleted": 2 }` (including disk files), broadcasts `materials_changed`.

### POST /api/materials/batch-import

`{ "ids": ["…", "…"], "projectId": "…" }` → `{ "ok": true, "count": 2 }`. Imports 1 frame each in the given order.

## Jobs

### GET /api/jobs

→ `{ "jobs": [ {…}, … ] }`, latest 50 by creation time descending (used for frontend job panel initial load; afterwards WS events are primary).

### GET /api/jobs/:id

```json
{
  "job": {
    "id": "…", "project_id": "…", "type": "extract_frames",
    "status": "done", "progress": "完成", "error": null, "created_at": 1785912000000
  }
}
```

`status`: `queued` / `running` / `done` / `error` / `cancelled`. Job payloads are in memory; on server restart, orphaned `queued` / `running` jobs are marked as `error` ("server restarted, job interrupted").

### POST /api/jobs/:id/cancel

Cancels a queued or running job → `{ "ok": true }`. `queued` immediately dequeued and marked `cancelled`; `running` triggers AbortSignal (kills `runCmd` subprocess / interrupts API polling). Already-finished status returns 409. Broadcasts `job_cancelled`.

## Folders /api/folders

Material library and project list share multi-level folders (`kind`: `material` | `project`). Resources belong via `folder_id`; deleting a folder moves contents up to the parent (resources are not deleted).

### GET /api/folders?kind=material|project

→ `{ "folders": [ { id, kind, parent_id, name, sort, created_at }, … ] }` (flat list, frontend builds tree).

### POST /api/folders

`{ "kind": "material", "name": "Characters", "parentId": null }` → `{ "folder": {…} }`, broadcasts `folders_changed`.

### PATCH /api/folders/:id

`{ "name"?, "parentId"? }` (cannot move to self or descendants).

### DELETE /api/folders/:id

Moves subtree resources up to parent, then deletes the entire folder subtree.

### POST /api/folders/move-items

`{ "kind": "material", "ids": ["…"], "folderId": null }` → `{ "ok": true, "moved": n }` (`folderId: null` = ungrouped).

## WebSocket /ws

Server → client one-way broadcast, JSON:

```json
{ "type": "frame_updated", "payload": { "id": "…", "projectId": "…" } }
```

| type | When |
| --- | --- |
| `job_queued` / `job_running` / `job_progress` / `job_done` / `job_error` / `job_cancelled` | Job lifecycle |
| `frame_updated` | PATCH / replace / frame matting complete |
| `frames_changed` | Import complete / duplicate / delete / material import to project |
| `frames_reordered` | Reorder |
| `project_deleted` | Delete project |
| `material_updated` | Material rename / matting complete / restore raw / crop replace image |
| `materials_changed` | Material upload / generate / batch delete / move folder |
| `folders_changed` | Folder add/remove/update / move |
| `settings_changed` | Setting written (layout / theme / lang / genProvider / matting) |

Frontend recommendation: on receiving `frame_updated` / `frames_reordered` / `frames_changed` / `job_done`, re-fetch frame list; on `material_updated` / `materials_changed`, re-fetch material list; reconnect 3s after disconnect.

## UI Preferences /api/settings

Layout (editor panel sizes), theme mode, interface language, generation providers, matting config, etc. are persisted server-side in `settings` table (SQLite) — survives browser changes and restarts; theme and language use frontend localStorage as first-paint cache only, silently degrades when server is unreachable.

### GET /api/settings

Returns entire kv object (values JSON-parsed):

```json
{
  "layout": { "sidebarW": 260, "timelineH": 160 },
  "theme": "dark",
  "lang": "zh",
  "genProviders": [
    {
      "id": "…", "name": "OpenAI", "type": "api",
      "cliTemplate": "", "apiBaseUrl": "https://api.openai.com/v1", "apiKey": "sk-…",
      "apiModels": ["gpt-image-1"], "apiSize": "1024x1024"
    },
    { "id": "…", "name": "Local mygen", "type": "cli", "cliTemplate": "mygen --prompt \"{prompt}\" -o {output}", "apiBaseUrl": "", "apiKey": "", "apiModels": [], "apiSize": "" }
  ],
  "matting": { "cliTemplate": "", "model": "u2net" }
}
```

### PUT /api/settings/:key

```json
// Request (key allowlist: layout, theme, lang, genProviders, matting, imageLayers, promptEnhancers; other keys return 400)
{ "value": { "sidebarW": 260, "timelineH": 160 } }
// Response
{ "ok": true }
```

`theme` valid values: `"system"` (follow system) / `"light"` / `"dark"`. `lang` valid values: `"zh"` / `"en"`. Broadcasts `settings_changed` `{ key }` after write.

`genProviders`: generation provider list. Connection credentials stored once (`apiBaseUrl` / `apiKey`); capabilities split by `imageModels` / `videoModels` / `textModels`; default sizes for image and video are `imageSize` / `videoSize` respectively. Server still reads legacy `apiModels` / `apiSize`: legacy models are migrated by name to image or video capabilities; legacy sizes serve as fallback for both types; settings page only writes new fields. CLI continues using `cliBin`, parameter names, and `cliExtraArgs` structured argv — no shell; when list is empty, env `FRAMEBAKER_GEN_CLI` is fallback.

`promptEnhancers` elements are `{ id, name, providerId, model }`, reusing `api` or `dashscope` provider connection credentials; legacy `{ apiBaseUrl, apiKey, apiModel }` still readable at runtime. `POST /api/enhance-prompt` accepts `mediaKind: "image" | "video"` and `referenceImageCount` (0–10). The server selects text-to-generation, single-reference, or ordered multi-reference prompt semantics from that complete context.

`matting`: structured matting command `cliBin` / `cliInputArg` / `cliOutputArg` / `cliModelArg` (all empty → falls back to env `FRAMEBAKER_MATTING_CLI` template → auto-detection); `model` empty falls back to `FRAMEBAKER_MATTING_MODEL` / default `u2net`.

`imageLayers`: standalone image-layer service configuration `{ "apiBaseUrl", "apiKey", "model" }`. It is independent from generation providers and calls `POST {apiBaseUrl}/images/layers`. If this setting has never been saved, the server temporarily reads the first legacy `genProviders[].layerModels` entry for migration compatibility.

### POST /api/materials/:id/layers

Queues semantic scene-layer decomposition. It reconstructs editable RGBA layers such as background, whole subject, props, and foreground; it does not promise character body parts or strict pixel-label segmentation. Source must be an image (processed preferred over raw), and the standalone `imageLayers` setting must contain Base URL, API key, and model. The async job type is `image_layers`. Full scenes should normally use `autoMatting: false` to preserve context. For an already isolated foreground without a processed image, set `autoMatting: true` to remove its background within the same job before the layer service is called; if matting fails or is cancelled, the layer request is not sent.

```json
{ "layers": 4, "numInferenceSteps": 50, "trueCfgScale": 4, "negativePrompt": "", "seed": 0, "autoMatting": false }
```

Ranges: `layers` 1–4 (the current Gitee Qwen-Image-Layered endpoint rejects values above 4), `numInferenceSteps` 1–100 (UI/MCP default `50`, matching the upstream quality configuration), `trueCfgScale` 0–20 (default `4`), integer `seed >= 0`. Returns `{ "jobId": "…" }`; result layers become raw materials in the source folder. For deeper decomposition, split one returned layer again recursively.

## Animation Assets /api/animation-assets

- `GET /api/animation-assets?kind=...` lists stored Skeleton and MotionClip action assets. CharacterBinding is project-local and is never exposed by this library.
- `POST /api/animation-assets` creates `{ asset, folderId? }`; `GET`, `PUT`, and `DELETE /api/animation-assets/:id` read, replace, and delete one Skeleton or MotionClip. Posting a CharacterBinding is rejected.
- `GET /api/projects/:id/skeletal-document` reads a skeletal project's document; `PUT` replaces it. The document owns its character's CharacterBinding and material references. Project actions may reference only MotionClips with the exact same `skeletonId`.
- MotionClip `schemaVersion: 1` keeps track-level `step | linear`. MotionClip `schemaVersion: 2` removes track-level interpolation and requires every key to carry `outInterpolation`: non-terminal keys use `{ type: "step" | "linear" }` or `{ type: "cubic-bezier", x1, y1, x2, y2 }`, while the terminal key uses `null`. Bézier controls must be finite values in `[0, 1]`.
- Reading or saving v1 does not upgrade it. The editor upgrades to v2 only when the user explicitly selects a cubic curve. `.fbanim` package versions remain independent from embedded MotionClip schema versions.

## Other

- `GET /api/health` → `{ "ok": true, "name": "FrameBaker" }`
- `GET /api/config` → server capability detection (resolved in real-time per request, settings page changes take effect immediately):

```json
{
  "matting": {
    "engine": "rembg-bundled",
    "model": "u2net",
    "hint": null,
    "modelCached": true
  },
  "imageLayers": {
    "configured": true,
    "model": "Qwen-Image-Layered"
  },
  "gen": {
    "providers": [
      { "id": "…", "name": "OpenAI", "type": "api", "models": ["gpt-image-1"], "configured": true }
    ]
  }
}
```

  `engine`: `custom-cli` (settings page matting.cliTemplate or `FRAMEBAKER_MATTING_CLI`) / `rembg-bundled` (`.venv-matting` bundled) / `rembg-path` (found in PATH) / `none` (not installed, matting only copies raw, `hint` contains install instructions). `model` is rembg model name (settings page matting.model → `FRAMEBAKER_MATTING_MODEL` → default `u2net`); `modelCached` indicates model file exists in `storage/models` (uncached models auto-download on first matting). `imageLayers` reports the standalone image-layer service state without exposing its API key. `gen.providers` is a summary of all generation providers (no apiKey; model capability lists feed generation dialogs, `configured` indicates key fields are complete, `video` indicates video generation support — CLI/DashScope/MiniMax only, mapping in shared constant `PROVIDER_VIDEO_SUPPORT`).
- `GET /api/doctor` → health check: checks storage directory writable / ffmpeg / matting engine & model cache / standalone image-layer service / each generation provider (CLI validates command existence; OpenAI-compatible sends `GET /models`, Gemini sends `GET /v1beta/models`, DashScope sends `GET /compatible-mode/v1/models` for connectivity test; MiniMax has no probe endpoint, field validation only) → `{ "checks": [{ "id", "ok", "label", "detail" }] }`.
- `POST /api/provider/test` → API provider connectivity test (uses current form values, no need to save first): `{ "type"?, "apiBaseUrl", "apiKey", "apiModel?" }`; api sends `GET {baseUrl}/models` + Bearer, gemini sends `GET {baseUrl}/v1beta/models` (x-goog-api-key), dashscope sends `GET {baseUrl}/compatible-mode/v1/models` + Bearer, returns `{ "ok", "status", "latencyMs", "modelsFound" }` (401/403 = authentication failure); minimax has no lightweight probe endpoint, field validation only with explanation in `note`.
- `POST /api/provider/models` → API provider model list (settings page "Fetch Models", uses current form values, no need to save first): `{ "type", "apiBaseUrl", "apiKey" }` → `{ "ok", "models": ["…"] }`; endpoints same source as connectivity test (api `/models`, dashscope `/compatible-mode/v1/models`, gemini `/v1beta/models` strips `models/` prefix; minimax best-effort tries `/v1/models`); failure returns `{ "ok": false, "error" }`, frontend keeps manual input.
- `POST /api/enhance-prompt` → prompt enhancement (enhancer model configured in settings page, OpenAI-compatible `chat/completions`, enhancement system prompt built in server-side): `{ "enhancerId"?, "prompt", "style"?, "mediaKind"?, "referenceImageCount"? }` → `{ "enhanced", "enhancerName" }`. `style` selects pixel/anime/illustration/3d/realistic/general rules and examples; `mediaKind` selects image/video guidance; `referenceImageCount` (0–10) selects text-to-generation, single-reference, or ordered Image 1…N multi-reference semantics. The frontend forwards current selections and clears stale comparisons when they change. Invalid conversational/clarification responses are corrected once, then rejected with a clear error.
- `GET /fonts/:name` → font files from `apps/web/public/fonts/` (woff2 / OFL.txt)
- `GET /imageops/imageOps.worker.js` → frontend crop worker script (server `Bun.build`s `apps/web/src/imageops/imageOps.worker.ts` on demand; development mode rebuilds each time, production caches)

## MCP (Model Context Protocol) Endpoint

FrameBaker includes a built-in MCP server that allows AI assistants (Claude Desktop / Claude Code / Cursor / Windsurf etc.) to operate on projects, frames, materials, jobs, and all other features via the MCP protocol.

### Transport

Based on `@modelcontextprotocol/server` SDK v2 Streamable HTTP transport, auto-compatible with 2025-era (`initialize` handshake) and 2026-07-28 (stateless core) protocol versions.

- `POST /mcp`: receives JSON-RPC requests, returns JSON responses
- `GET /mcp`: SSE channel (server → client notifications)
- `DELETE /mcp`: end session

Protocol version negotiation and session management are handled automatically by the SDK; all tools are stateless direct db operations.

### Client Setup

**Claude Desktop** (macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "framebaker": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Claude Code** (CLI):

```bash
claude mcp add framebaker --transport http http://localhost:3000/mcp
```

**Cursor** (`.cursor/mcp.json` in project root, or global settings):

```json
{
  "mcpServers": {
    "framebaker": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "framebaker": {
      "serverUrl": "http://localhost:3000/mcp"
    }
  }
}
```

### Quick Start for AI Agents

Copy and paste the following to your AI agent to get started:

```
FrameBaker is running at http://localhost:3000 with an MCP server at /mcp (Streamable HTTP).
Connect to it and use `list_projects` to get started.
Available tools: list_projects, create_project, list_frames, generate_frames, list_materials, matting_material, list_jobs, get_config, and 40 more.
All tools manage pixel-art animation projects — frames, materials, generation, matting, folders, jobs, and settings.
```

### Handshake (2025-era Clients)

```json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "my-client", "version": "1.0" } } }
// Response
{ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18", "capabilities": { "tools": {} }, "serverInfo": { "name": "framebaker", "version": "0.5.0" } } }
```

After handshake, send `notifications/initialized` notification (no response needed), then `tools/list` and `tools/call` are available. 2026-07-28 clients can skip the handshake and call directly.

### Tool List

| Tool | Description |
| --- | --- |
| `list_projects` | List all projects |
| `get_project` | Get single project details |
| `create_project` | Create a project |
| `update_project` | Update project name/folder |
| `delete_project` | Delete project and all its frames/jobs/files |
| `list_frames` | List all frames in a project |
| `update_frame` | Update frame image properties/transform |
| `delete_frame` | Delete a frame |
| `clear_frame_cell` | Clear a timeline cell without deleting reusable asset files |
| `get_timeline` | Get tracks, steps, image cells, and independent effect cells |
| `upsert_attack_effect` | Create or replace an attack effect in any track × step cell |
| `duplicate_frame` | Duplicate frame 1–16 copies |
| `reorder_frames` | Reorder frames |
| `generate_frames` | Generate frames for a project (AI provider) |
| `generate_materials` | Generate materials (AI provider) |
| `list_materials` | List all materials |
| `rename_material` | Rename one image or video material |
| `matting_material` | Single material background removal |
| `split_material_layers` | Split an image material with the standalone image-layer service |
| `batch_matting` | Batch background removal |
| `extract_material_frames` | Extract video/GIF material frames |
| `import_material_to_project` | Import material as project frame |
| `batch_import_materials` | Batch import materials to project |
| `batch_delete_materials` | Batch delete materials |
| `unmatting_material` | Restore raw (remove matting result) |
| `list_folders` | List folders |
| `create_folder` | Create folder |
| `update_folder` | Update folder |
| `delete_folder` | Delete folder (contents move up) |
| `move_items_to_folder` | Move materials/projects to folder |
| `list_jobs` | List recent jobs |
| `get_job` | Query single job status |
| `cancel_job` | Cancel job |
| `get_config` | Get server config (providers/matting engine) |
| `run_doctor` | Health check |
| `get_settings` | Get all settings |
| `update_setting` | Update a single setting |
| `enhance_prompt` | Enhance prompt |

### Tool Call Examples

```json
// List projects
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "list_projects", "arguments": {} } }

// Create project
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "create_project", "arguments": { "name": "走路循环" } } }

// Generate frames
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "generate_frames", "arguments": { "projectId": "…", "prompt": "pixel art knight walk cycle", "count": 4 } } }

// Query job status
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "get_job", "arguments": { "jobId": "…" } } }
```

Tools return `content: [{ type: "text", text: "…" }]` format (text is a JSON string); on error `isError: true`.
