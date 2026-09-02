# FrameBaker API

Base URL：`http://localhost:3000`，除标注外均为 `/api` 前缀。请求/响应类型定义见 `packages/shared/src/types.ts`。

约定：

- 所有 id 为 UUID 字符串
- 帧的 `tags` / `metadata` 在 API 输出中已解析为 JSON（DB 中为字符串）
- 错误响应：非 2xx + 纯文本中文错误信息
- 写操作触发 WS 广播（`/ws`，消息格式 `{ "type": string, "payload": any }`，type 见文末）

## 项目

### GET /api/projects

项目列表，按创建时间倒序。`has_thumbnail` 表示是否存在项目缩略图 PNG（见下文）。

```json
{
  "projects": [
    { "id": "…", "name": "走路循环", "created_at": 1785912000000, "frame_count": 8, "first_frame_id": "…", "has_thumbnail": false }
  ]
}
```

### POST /api/projects

```json
// 请求
{ "name": "走路循环" }
// 响应
{ "id": "…", "name": "走路循环" }
```

### GET /api/projects/:id

```json
{ "project": { "id": "…", "name": "…", "created_at": 1785912000000, "frame_count": 8, "has_thumbnail": false } }
```

### PUT /api/projects/:id/thumbnail

上传前端渲染好的项目缩略图。body 为 PNG 二进制（`Content-Type: image/png`，最大 2MB，校验 PNG 魔数），存到 `storage/thumbnails/projects/<id>.png`。项目不存在返回 404 → `{ "ok": true }`。

### GET /api/projects/:id/thumbnail

返回已存的 PNG（`Content-Type: image/png`，支持 ETag/Last-Modified）；项目或缩略图不存在返回 404。更新后可追加 `?v=<时间戳>` 破缓存。

### PATCH /api/projects/:id

`{ "name": "新名字" }` → `{ "ok": true }`

### DELETE /api/projects/:id

删除项目及其全部帧、任务与磁盘文件（含项目缩略图） → `{ "ok": true }`，广播 `project_deleted`。

## 帧

### GET /api/projects/:id/frames

兼容视图：仅返回默认动画轴的主轨，按规范共享步骤排序。响应包含 `track_id`、`step_id`；步骤的 `idx`/`duration` 为权威值，帧字段暂作镜像。

按 `idx` 升序返回：

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

PNG 图片流。`type=processed` 且无 processed 文件时回退 raw。可选整数参数 `size` 返回宽高均不超过该值的缓存缩略图；参数非法或越界时返回原图。缩略图使用 ImageMagick 或 ffmpeg，两者均不可用时无损回退原图。响应包含 `ETag` / `Last-Modified`；带 `v` 的版本化 URL 使用一年 immutable 缓存，未带版本时执行重新验证。404：帧或文件不存在。

### PATCH /api/frames/:id

可更新字段（至少一个，全部可选）：`offset_x` / `offset_y`（-100000–100000）、`scale`（0.1–8）、`rotation`（弧度，-π–π）、`opacity`（0–1）、`duration`（int 1–600）、`is_keyframe`（0/1）及 `tags`（string[]）。攻击特效是独立时间轴单元格，使用下述专用接口，不再随图片帧 PATCH。

```json
// 请求
{ "offset_x": 12.5, "duration": 3, "is_keyframe": 1 }
// 响应
{ "frame": { /* 更新后的完整帧 */ } }
```

广播 `frame_updated`。

### POST /api/frames/:id/replace

multipart/form-data：`file`（PNG，服务端校验文件签名）。编辑器会先通过 CropModal 剪裁/编码，再写入 `processed/<id>_replaced.png`；旧 processed 文件会被清理，`source` 置为 `upload`，状态置 `ready`。响应 `{ "frame": {…} }`，广播 `frame_updated`。

### POST /api/frames/:id/duplicate?count=N

复制 N 份（1–16，默认 1）插入原帧之后，复制图片文件与全部属性，`source=duplicate`，后续帧 idx 顺延。响应 `{ "ok": true, "count": 2 }`，广播 `frames_changed`。

### DELETE /api/frames/:id

删除帧与图片文件，同项目后续帧 idx 前移。`{ "ok": true }`，广播 `frames_changed`。

## 规范合成时间轴

- `GET /api/projects/:id/timeline?axisId=`：返回项目全部动画轴，以及选中/默认轴、轨道、共享步骤、图片 `frames`、独立攻击特效 `effects`、待编排 `poolFrames` 和左侧可复用 `assetFrames`。
- `POST /api/projects/:id/axes`（`name`、可选 `fps`）；`PATCH /api/axes/:id`；`DELETE /api/axes/:id`（保护唯一轴）。
- `POST /api/axes/:id/tracks`；`PATCH|DELETE /api/tracks/:id`；`POST /api/axes/:id/tracks/reorder` 接收完整且不重复的 `trackIds`。主轨/唯一轨道不可删除。
- `POST /api/axes/:id/steps`；`PATCH|DELETE /api/steps/:id`；`POST /api/axes/:id/steps/reorder` 接收完整且不重复的 `stepIds`。时长范围 1–600，并镜像到步骤内全部单元格。
- `PATCH /api/frames/:id/placement` 请求 `{ "trackId", "stepId", "swap"?, "copy"? }`；时间轴内部移动沿用原帧，左侧组装使用 `copy: true` 创建实例，源资产始终留在左侧并可重复使用。`swap: true` 时目标已有帧会退回资产面板。
- `DELETE /api/frames/:id/placement` 清空单个时间轴单元格但不删除可复用图片文件；资产帧退回资产面板，复制出的时间轴实例则丢弃。
- `POST /api/tracks/:id/place-frames` 请求 `{ "frameIds": [...], "startStepId"? }`，把同项目帧资产依次复制到目标轨道的连续单元格。已有单元格帧退回资产面板，末尾步骤不足时原子追加；跨项目来源与非资产帧会在时间轴变更前被拒绝。
- `PUT /api/tracks/:id/steps/:stepId/effect`：在任意轨道×步骤单元格创建或替换特效，即使该格没有图片也可使用。请求最多 128 条笔画；每笔保存 `#RRGGBB` 颜色、1–256 笔宽、可选且确定性渲染的纹理 `brush`（`slash`、`bristle`、`dry`、`spark`、`echo`，缺省为 `slash`）及最多 4096 个 `{x,y,pressure}` 点，以及独立位置/缩放/旋转/透明度和可选 `style`（`flame`、`energy`、`ink`）。同 URL 的 `DELETE` 只清除特效，不影响该格的人物图片。

时间轴变更广播 `timeline_changed` 及 `projectId` 和相关 ID。删除单元格仅在步骤变空时裁剪步骤；旧复制会在源步骤后插入共享步骤；旧换序仅接受主轨“一步骤一单元格”的无歧义形态。

- `POST /api/projects/:id/undo`：恢复该项目最近一次成功的时间轴/帧编辑。服务端为每个项目最多保留 50 条快照；纯数据库编辑不会复制图片，替换、删除、复制或导入项目图片时才同时保存项目文件。同项目编辑与撤销请求会串行执行，恢复失败时回滚且不消费快照。异步任务完成及 MCP 项目写入会清除更早的历史，防止陈旧快照覆盖较新的产物。恢复成功后广播 `timeline_changed` 和 `frames_changed`；没有可撤销历史时返回 404。

### POST /api/projects/:id/reorder

```json
// 请求：必须恰好包含项目全部帧 id
{ "frameIds": ["id3", "id1", "id2"] }
// 响应
{ "ok": true }
```

按数组顺序重写 idx（事务）。400：集合不匹配。广播 `frames_reordered`。

## 导入

### POST /api/import/upload

multipart/form-data：

| 字段 | 说明 |
| --- | --- |
| `file` | 素材文件 |
| `projectId` | 目标项目 |
| `type` | `gif`（全部帧）/ `mp4`（按 fps 抽帧）/ `image`（单图一帧） |
| `fps` | 可选，mp4 抽帧帧率，默认 8（1–60） |
| `autoMatting` | 可选，`"true"` 时每帧再入队抠图任务 |

响应 `{ "jobId": "…" }`，随后轮询 `GET /api/jobs/:id` 或等 WS `job_done`。

```bash
curl -F "file=@test.gif" -F "projectId=$PID" -F "type=gif" http://localhost:3000/api/import/upload
```

### POST /api/import/generate

```json
// 请求
{ "projectId": "…", "prompt": "pixel art knight", "count": 4, "autoMatting": false, "providerId": "…", "model": "wanx2.1-image", "size": "1328*1328", "references": [{ "kind": "material", "id": "…" }, { "kind": "frame", "id": "…" }], "mediaKind": "image" }
// 响应
{ "jobId": "…", "jobIds": ["…", "…", "…", "…"] }
```

provider 解析：传了 `providerId` 按 id 找（找不到 400）；缺省用第一个配置齐备的 provider（设置页可配多个共存，类型：`cli` / `api`（OpenAI 兼容）/ `dashscope`（百炼原生）/ `gemini`（banana）/ `minimax`；列表为空时 env `FRAMEBAKER_GEN_CLI` 合成 id=`env` 的 CLI provider 兜底）。可选 `size` 在生成时覆盖 provider 的 `apiSize`（格式随 provider 类型：api 如 `1024x1024`、dashscope 如 `1328*1328`、gemini/minimax 如 `16:9`；预设档位见共享常量 `GEN_SIZE_PRESETS`；CLI provider 无尺寸概念忽略）。

- **CLI provider**：结构化字段组装 argv（`cliBin` + 参数名映射：`cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`，留空=位置参数或不下发），不经 shell。多张引用图按选择顺序重复下发 `cliReferenceArg path`。env `FRAMEBAKER_GEN_CLI` 与旧数据使用遗留模板占位符（`{prompt}` `{output}` `{index}` `{reference}` `{model}`），因此只支持一张引用图。
- **API provider（OpenAI 兼容，含 OpenAI 官方 / 火山方舟豆包 Seedream / 各类网关）**：无引用图走 `POST {apiBaseUrl}/images/generations`（JSON `{ model, prompt, size?, n: 1 }`）；有引用图走 `POST {apiBaseUrl}/images/edits`（multipart：单图使用 `image`，多图按顺序重复 `image[]`，另含 prompt/model/size；需模型支持，如 gpt-image 系列；dall-e-3 不支持 edits）。响应取 `data[0].b64_json` 或 `data[0].url` 下载。
- **DashScope provider（百炼原生）**：`POST {apiBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`（wan2.7-image / qwen-image 等，不在兼容模式内）；无引用图 content 仅 `[{text}]`，每张引用图按选择顺序前置一个 `{image: dataURI}`。响应取 `output.choices[0].message.content[*].image` URL 下载（24h 有效）。`apiSize` 可为 `2K`/`1K`/`4K` 或星号格式（如 `2048*2048`）原样透传。**Base URL 归一**（`normalizeDashscopeBaseUrl`）：可填 Token Plan `https://token-plan.cn-beijing.maas.aliyuncs.com`，或文档兼容地址 `…/compatible-mode/v1` / 尾部 `/api/v1`（服务端剥掉后缀再拼原生路径）；按量付费常用 `https://dashscope.aliyuncs.com`。
- **Gemini provider（banana / nano-banana）**：`POST {apiBaseUrl}/v1beta/models/{model}:generateContent`（`x-goog-api-key` 头）；每张引用图按顺序作为 `{inlineData: {mimeType,data}}` part 放在文本 part 前；`apiSize` 映射 `imageConfig.aspectRatio`（如 `16:9`）。适配器遍历全部 candidate/part 查找 `inlineData.data`（兼容代理的 `inline_data`）；HTTP 200 却无图片时会明确报告 `promptFeedback.blockReason`、候选 `finishReason`、安全类别、模型拒绝文本及 `responseId`，仅对 `NO_IMAGE`、`IMAGE_OTHER` 或暂时性空候选自动重试一次。
- **MiniMax provider**：`POST {apiBaseUrl}/v1/image_generation`（Bearer）；引用图走 `subject_reference`（主体特征保持，限一张，base64 dataURI）；`apiSize` 映射 `aspect_ratio`（如 `16:9`）；`response_format=base64`，响应取 `data.image_base64[0]`，`base_resp.status_code` 非 0 视为失败。

模型取请求的 `model`，缺省 provider 模型列表第一项，都没有则任务 error。provider 不存在/配置不齐时任务置 `error` 并给出说明。`count` 1–16。图片模式下每个产物拆成一个独立任务，按全局队列并发数运行；`jobId` 为兼容保留并指向首个任务，`jobIds` 返回整批任务。

- **视频模式**：`mediaKind: "video"`——只生成并保存一段视频素材（`raw.mp4`，不抽帧；`count`/`fps` 忽略）。仅支持 CLI / 百炼 / MiniMax。完成后用 `POST /api/materials/:id/extract`（fps 或 timestamps）抽帧成多张图片素材。

- **CLI provider**：`{output}` 给 `.mp4` 后缀路径，产出经魔数检测为视频（ftyp/EBML/RIFF-AVI）则走 ffmpeg 抽帧。**图片模式下 CLI 产物若实为视频同样自动转拆帧**（此时 `count` 忽略）。
- **MiniMax provider**：按模型分协议——`MiniMax-Hailuo-*` / `T2V-*` 走 v1：`POST {apiBaseUrl}/v1/video_generation`（`{ model, prompt, duration? }`）→ `task_id`；轮询 `GET {apiBaseUrl}/v1/query/video_generation?task_id=`（`status`：Success/Fail 等）取 `file_id`，再 `GET {apiBaseUrl}/v1/files/retrieve?file_id=` 取 `download_url`。`MiniMax-H3` 等走 v2：`POST {apiBaseUrl}/v2/video_generation`（`{ model, content:[{type:"text",text}], duration, ratio? }`）→ `task_id`；轮询 `GET {apiBaseUrl}/v2/query/video_generation/{task_id}`（`task.status`：succeeded/failed/cancelled），成功取 `task.content.url` 下载。默认 `duration=6`；文生视频缺省 `ratio=16:9`。
- **DashScope provider（万相 / HappyHorse）**：`POST {apiBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis`（头 `X-DashScope-Async: enable`）。文生视频 `happyhorse-1.1-t2v`：`input:{prompt}` + `parameters:{resolution,ratio,duration,watermark:false}`；图生视频 `*-i2v` 只能使用一个 `input.media[{type:first_frame,url}]`；参考生视频 `*-r2v` 为每张引用图按顺序下发一个 `{type:reference_image}`。→ `output.task_id`；轮询 `GET {apiBaseUrl}/api/v1/tasks/{task_id}`（`output.task_status`：PENDING/RUNNING/SUCCEEDED/FAILED），成功取 `output.video_url` 下载。旧 wanx 仍可把 `apiSize` 当 `size` 透传。

视频为异步任务（约 1–5 分钟），进度写 `job.progress` 并经 WS 推送。百炼 i2v 接受一张引用图，r2v 接受多张；MiniMax 视频会明确拒绝引用图而不是静默忽略；CLI 行为取决于所配置的参数。

引用图通过有序 `references` 数组传入（最多 10 张）：`{ "kind": "material" | "frame", "id": "…" }`，可以混合素材与项目帧。服务端逐个按 id 解析文件路径（优先 processed，否则 raw），防止客户端路径注入。旧版单图字段 `referenceMaterialId` / `referenceFrameId` 继续兼容，但不能与 `references` 同传。OpenAI 兼容、百炼、Gemini 图片协议支持多图；MiniMax 与旧版 CLI 模板超过一张时会明确拒绝。

可选 `flattenBackground` 必须是 `#RRGGBB` 色值，且仅在存在引用图时生效。调用 provider 前，服务端用 ImageMagick 把每张已解析引用图临时合成到该纯色背景，文件放入 `storage/staging/genbg_*`；不会修改源素材/项目帧，任务完成、失败或取消后都会清理暂存目录。未安装 ImageMagick 时继续使用原引用图生成，并在已完成任务中保留“未检测到 ImageMagick，已跳过垫底图”警告。

## 素材库 /api/materials

素材先在素材库生成/上传、抠图、对比，确认后再导入项目成为帧。素材的 `source` 语义与帧一致（`cli`/`api`/`dashscope`/`gemini`/`minimax`/`upload`/`gif`/`mp4`/`image`/`duplicate`；AI 生成按实际 provider 类型写入，不再一律 `cli`），`status` 为 `raw`（原图）/ `matted`（已抠图）。素材与项目均可挂 `folder_id`（见 `/api/folders`）。

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

重命名单个图片或视频素材。请求 `{ "name": "新素材名称" }`（自动去除首尾空格，长度 1–200）→ `{ "material": {…} }`。素材不存在时返回 404；成功后广播 `material_updated`。

### GET /api/materials/:id/image?type=raw|processed&size=64..1024&v=VERSION

素材图片/视频流。`type=processed` 且无 processed 时回退 raw。图片素材可通过可选整数参数 `size` 获取宽高均不超过该值的缓存缩略图；参数非法或越界时返回原图。缩略图使用 ImageMagick 或 ffmpeg，两者均不可用时无损回退原图。响应包含 `ETag` / `Last-Modified`；带 `v` 的版本化 URL 使用一年 immutable 缓存，未带版本时执行重新验证。视频响应忽略 `size`。

### POST /api/materials/upload

multipart/form-data：`file` + 可选 `processedFile`、`metadata`（JSON 对象字符串；也兼容 Elysia multipart 自动解析后的对象）、`autoMatting`(`"true"`)、`fps`（视频抽帧，默认 8）。传 `processedFile` 时素材同时保存 raw/processed 两个槽位并标记 `status=matted`；网格拆分用它保留真实前后对比。
PNG/JPG 等单图 → 直接生成 1 个素材，响应 `{ "materialId": "…" }；GIF/MP4 → 队列拆帧每帧一个素材，响应 `{ "jobId": "…" }`。

```bash
curl -F "file=@slime.png" http://localhost:3000/api/materials/upload
curl -F "file=@walk.gif" -F "autoMatting=true" http://localhost:3000/api/materials/upload
```

### POST /api/materials/generate

`{ "prompt": "pixel slime", "count": 4, "autoMatting": false, "references": [{ "kind": "material", "id": "…" }], "flattenBackground": "#FF00FF" }` → `{ "jobId": "…", "jobIds": ["…", "…", "…", "…"] }`（provider 解析、图片独立任务、多引用图及临时 `flattenBackground` 处理规则同 `/api/import/generate`）。每个素材任务完成时都会广播 `materials_changed`，停留在素材库时会逐个刷新。可选 `name`：素材命名基准（缺省取 prompt 前 24 字符），产出命名为 `name #i`（count>1）——素材详情「多动作生成」按「素材名_动作」传入。支持 `mediaKind: "video"`：只生成并保存视频素材（`kind=video`），**不抽帧**；完成后用下方 extract 接口拆帧。骨骼分件生成支持成对提供 1–8 的 `gridRows` / `gridCols`，生成素材 metadata 和网格切分编辑器都会保留该布局；人形默认值为 `gridRows: 3`、`gridCols: 4`（12 个部件）。`skeletal-character` 两阶段请求可把相同字段放入 `followUp`，用于后续分件表。骨骼请求不再要求预先创建或传入 `characterPartSetId`：缺省时服务端自动建立内部部件集，并随 `jobId` 返回其 ID；显式 ID 仍为 API 兼容保留。

### POST /api/materials/:id/extract

视频/GIF 素材抽帧成多张图片素材 → `{ "jobId": "…" }`。复制源文件到 staging 后入队**一个** `extract_frames` 任务；产出命名为「原名 #i」，默认落在同一文件夹。非视频/GIF 返回 400。

- **整段按 fps**（默认，GIF/视频）：`{ "fps"?: 8, "autoMatting"?: false, "folderId"?: null }`
- **定点抽帧**（仅视频）：`{ "timestamps": [0.12, 0.5, 1.0], "autoMatting"?: false, "folderId"?: null }` —— 秒（浮点），排序去重，最多 64 个；GIF 传 timestamps 返回 400。服务端对每个时间点跑一次 `ffmpeg -ss T -i … -frames:v 1`（可取消）。

### POST /api/materials/:id/matting

入队抠图任务（`matting` job，队列并发 2），响应 `{ "jobId": "…" }`；素材不存在 404，缺 raw 文件 400。**同一素材已有 queued/running 抠图任务时 409**（禁止重复入队）。引擎解析顺序见 `GET /api/config`——自定义 CLI → 内置 rembg → PATH rembg → passthrough 复制（passthrough 警告写入 `job.progress`）。完成后 `status` 置 `matted` 并广播 `material_updated`；rembg 模型首次使用需下载（可达数百 MB），进度经 WS `job_*` 事件推送。

### POST /api/materials/batch-matting

`{ "ids": ["…", "…"] }` → `{ "ok": true, "count": 2, "skipped": 1 }`。仅对 `status=raw` 的素材入队抠图；已抠图或**已有进行中抠图任务**计入 `skipped`（详情页单条仍可重新抠，但进行中会 409）。

### POST /api/materials/:id/replace-image

multipart/form-data：`file`（PNG）+ `slot`（`"raw"` | `"processed"`）。剪裁工具的落盘端点：覆盖对应槽位文件；`slot=processed` 且尚无 processed 时建立之并置 `status=matted`，`slot=raw` 不影响已有 processed。响应 `{ "material": {…} }`，广播 `material_updated`。

### POST /api/materials/:id/unmatting

删除 processed、还原为 `raw` 状态。响应 `{ "material": {…} }`。

### POST /api/materials/:id/import

```json
// 请求
{ "projectId": "…", "count": 2 }
// 响应
{ "ok": true, "count": 2, "frameIds": ["…", "…"] }
```

把素材复制为待编排项目帧并放入左侧帧池。素材存在有效抠图结果时，导入帧的全部图片槽位都使用抠图图，避免后续操作静默退回原图；否则使用原图。素材库仍保留原图，仅用于明确的原图对比、还原抠图、重新抠图及原图导出。只有完成 placement 后才进入时间轴。`source` 与 metadata 均保留。`count` 1–16，默认 1。广播 `frames_changed`。

### POST /api/materials/batch-delete

`{ "ids": ["…", "…"] }` → `{ "ok": true, "deleted": 2 }`（连同磁盘文件），广播 `materials_changed`。

### POST /api/materials/batch-import

`{ "ids": ["…", "…"], "projectId": "…" }` → `{ "ok": true, "count": 2 }`。按给定顺序各导入 1 帧。

## 任务

### GET /api/jobs

→ `{ "jobs": [ {…}, … ] }`，按创建时间倒序取最近 50 条（前端任务面板初始加载用，之后以 WS 事件为主）。

### GET /api/jobs/:id

```json
{
  "job": {
    "id": "…", "project_id": "…", "type": "extract_frames",
    "status": "done", "progress": "完成", "error": null, "created_at": 1785912000000
  }
}
```

`status`：`queued` / `running` / `done` / `error` / `cancelled`。任务负载在内存中，服务重启时会把遗留的 `queued` / `running` 任务标记为 `error`（「服务重启，任务中断」）。

### POST /api/jobs/:id/cancel

取消排队中或运行中的任务 → `{ "ok": true }`。`queued` 直接出队标 `cancelled`；`running` 触发 AbortSignal（杀掉 `runCmd` 子进程 / 打断 API 轮询）。已结束状态返回 409。广播 `job_cancelled`。

## 文件夹 /api/folders

素材库与项目列表共用多级文件夹（`kind`: `material` | `project`）。资源通过 `folder_id` 归属；删除文件夹时内容上移到父级（不删资源）。

### GET /api/folders?kind=material|project

→ `{ "folders": [ { id, kind, parent_id, name, sort, created_at }, … ] }`（扁平列表，前端组树）。

### POST /api/folders

`{ "kind": "material", "name": "角色", "parentId": null }` → `{ "folder": {…} }`，广播 `folders_changed`。

### PATCH /api/folders/:id

`{ "name"?, "parentId"? }`（禁止移到自身或子孙下）。

### DELETE /api/folders/:id

子树内资源上移到父级后删除整棵文件夹子树。

### POST /api/folders/move-items

`{ "kind": "material", "ids": ["…"], "folderId": null }` → `{ "ok": true, "moved": n }`（`folderId: null` = 未分组）。

## WebSocket /ws

服务端 → 客户端单向广播，JSON：

```json
{ "type": "frame_updated", "payload": { "id": "…", "projectId": "…" } }
```

| type | 时机 |
| --- | --- |
| `job_queued` / `job_running` / `job_progress` / `job_done` / `job_error` / `job_cancelled` | 任务生命周期 |
| `frame_updated` | PATCH / 替换 / 帧抠图完成 |
| `frames_changed` | 导入完成 / 复制 / 删除 / 素材导入项目 |
| `frames_reordered` | 换序 |
| `project_deleted` | 删除项目 |
| `material_updated` | 素材重命名 / 抠图完成 / 还原原图 / 剪裁替换图片 |
| `materials_changed` | 素材上传 / 生成 / 批量删除 / 移动文件夹 |
| `folders_changed` | 文件夹增删改 / 移动 |
| `settings_changed` | 设置写入（layout / theme / lang / genProvider / matting） |

前端建议：收到 `frame_updated` / `frames_reordered` / `frames_changed` / `job_done` 后重拉帧列表，收到 `material_updated` / `materials_changed` 后重拉素材列表；断线 3s 重连。

## 界面偏好 /api/settings

布局（编辑器面板尺寸）、主题模式、界面语言、生成 provider、抠图配置等持久化在服务端 `settings` 表（SQLite），换浏览器/重启不丢；主题与语言前端以 localStorage 为首屏即时缓存，服务端不可达时静默降级。

### GET /api/settings

返回整个 kv 对象（value 已 JSON 解析）：

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
    { "id": "…", "name": "本地 mygen", "type": "cli", "cliTemplate": "mygen --prompt \"{prompt}\" -o {output}", "apiBaseUrl": "", "apiKey": "", "apiModels": [], "apiSize": "" }
  ],
  "matting": { "cliTemplate": "", "model": "u2net" }
}
```

### PUT /api/settings/:key

```json
// 请求（key 白名单：layout、theme、lang、genProviders、matting、imageLayers、promptEnhancers；其他 key 返回 400）
{ "value": { "sidebarW": 260, "timelineH": 160 } }
// 响应
{ "ok": true }
```

`theme` 的合法值：`"system"`（跟随系统）/ `"light"` / `"dark"`。`lang` 的合法值：`"zh"` / `"en"`。写入后广播 `settings_changed` `{ key }`。

`genProviders`：生成 provider 列表。连接凭证只存一次（`apiBaseUrl` / `apiKey`），能力按 `imageModels` / `videoModels` / `textModels` 分类，图片与视频默认尺寸分别为 `imageSize` / `videoSize`。服务端仍读取旧 `apiModels` / `apiSize`：旧模型按名称迁移到图片或视频能力，旧尺寸同时作为两类尺寸 fallback；设置页只写新字段。CLI 继续使用 `cliBin`、各参数名与 `cliExtraArgs` 的结构化 argv，不经 shell；列表为空时 env `FRAMEBAKER_GEN_CLI` 兜底。

`promptEnhancers` 元素为 `{ id, name, providerId, model }`，复用 `api` 或 `dashscope` provider 的连接凭证；旧 `{ apiBaseUrl, apiKey, apiModel }` 仍可读取运行。`POST /api/enhance-prompt` 可传 `mediaKind: "image" | "video"` 与 `referenceImageCount`（0–10），服务端据此选择文生、单引用图或有序多引用图的提示词语义。

`matting`：结构化抠图命令 `cliBin` / `cliInputArg` / `cliOutputArg` / `cliModelArg`（均留空走 env `FRAMEBAKER_MATTING_CLI` 模板 → 自动探测）；`model` 留空回退 `FRAMEBAKER_MATTING_MODEL` / 默认 `u2net`。

`imageLayers`：独立的图片分层服务配置 `{ "apiBaseUrl", "apiKey", "model" }`，不再归属生成 Provider，执行时调用 `POST {apiBaseUrl}/images/layers`。若该设置从未保存，服务端会临时读取首个旧 `genProviders[].layerModels` 配置以兼容迁移。

### POST /api/materials/:id/layers

创建语义场景分层任务，把扁平图重建为背景、完整主体、道具和前景等可编辑 RGBA 层；不承诺人物肢体拆件，也不是严格的像素标签分割。素材必须为图片（优先 processed，再回退 raw），且独立的 `imageLayers` 设置必须填写 Base URL、API Key 和模型。异步任务类型为 `image_layers`。完整场景通常应传 `autoMatting: false` 保留上下文；继续细分已独立前景且素材没有处理图时，才可传 `autoMatting: true`，在同一任务内先抠图再调用分层服务。抠图失败或取消时不会发送分层请求。

```json
{ "layers": 4, "numInferenceSteps": 50, "trueCfgScale": 4, "negativePrompt": "", "seed": 0, "autoMatting": false }
```

范围：`layers` 1–4（当前 Gitee Qwen-Image-Layered 端点会拒绝大于 4 的值）、`numInferenceSteps` 1–100（UI/MCP 默认 `50`，与上游质量配置一致）、`trueCfgScale` 0–20（默认 `4`）、整数 `seed >= 0`。返回 `{ "jobId": "…" }`；结果图层作为 raw 素材写入原素材文件夹。如需继续细分，可对某个输出图层再次递归分层。

## 动画资产 /api/animation-assets

- `GET /api/animation-assets?kind=...` 列出 Skeleton 与 MotionClip 动作资产。CharacterBinding 只属于项目，不会由该资产库暴露。
- `POST /api/animation-assets` 以 `{ asset, folderId? }` 创建资产；`GET`、`PUT`、`DELETE /api/animation-assets/:id` 分别读取、整体替换和删除单项 Skeleton 或 MotionClip。提交 CharacterBinding 会被拒绝。
- `GET /api/projects/:id/skeletal-document` 读取骨骼项目文档，`PUT` 整体替换。项目文档拥有角色 CharacterBinding 和素材引用；项目动作只能引用 `skeletonId` 完全相同的 MotionClip。
- MotionClip `schemaVersion: 1` 保持轨道级 `step | linear`。MotionClip `schemaVersion: 2` 不再含轨道级 interpolation，每个 key 必须携带 `outInterpolation`：非末尾 key 使用 `{ type: "step" | "linear" }` 或 `{ type: "cubic-bezier", x1, y1, x2, y2 }`，末尾 key 固定为 `null`。贝塞尔控制量必须是 `[0, 1]` 内的有限数值。
- 读取或保存 v1 不会自动升级；只有用户明确选择曲线时编辑器才升级到 v2。`.fbanim` 包版本与包内 MotionClip schema 版本独立演进。

## 其他

- `GET /api/health` → `{ "ok": true, "name": "FrameBaker" }`
- `GET /api/config` → 服务端能力探测（每次请求实时解析，设置页改动即时生效）：

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

  `engine`：`custom-cli`（设置页 matting.cliTemplate 或 `FRAMEBAKER_MATTING_CLI`）/ `rembg-bundled`（`.venv-matting` 内置）/ `rembg-path`（PATH 中找到）/ `none`（未安装，抠图仅复制原图，`hint` 为安装提示）。`model` 为 rembg 模型名（设置页 matting.model → `FRAMEBAKER_MATTING_MODEL` → 默认 `u2net`），`modelCached` 表示模型文件已在 `storage/models`（未缓存首次抠图自动下载）。`imageLayers` 只返回独立图片分层服务的可用状态，不暴露 API Key。`gen.providers` 为全部生成 provider 的摘要（不含 apiKey；模型能力列表供生成弹窗使用，`configured` 表示关键字段齐备，`video` 表示支持视频生成——仅 cli/dashscope/minimax，映射见共享常量 `PROVIDER_VIDEO_SUPPORT`）。
- `GET /api/doctor` → 体检：逐项检查存储目录可写 / ffmpeg / 抠图引擎与模型缓存 / 独立图片分层服务 / 每个生成 provider（CLI 校验命令存在；OpenAI 兼容实发 `GET /models`、Gemini 实发 `GET /v1beta/models`、百炼实发 `GET /compatible-mode/v1/models` 联通测试；MiniMax 无探测端点仅校验字段）→ `{ "checks": [{ "id", "ok", "label", "detail" }] }`。
- `POST /api/provider/test` → API provider 联通测试（用表单当前值，不要求已保存）：`{ "type"?, "apiBaseUrl", "apiKey", "apiModel?" }`；api 实发 `GET {baseUrl}/models` + Bearer、gemini 实发 `GET {baseUrl}/v1beta/models`（x-goog-api-key）、dashscope 实发 `GET {baseUrl}/compatible-mode/v1/models` + Bearer，返回 `{ "ok", "status", "latencyMs", "modelsFound" }`（401/403 判定为认证失败）；minimax 无轻量探测端点，仅校验字段并在 `note` 说明。
- `POST /api/provider/models` → API provider 模型列表（设置页「获取模型」，用表单当前值拉取，不要求已保存）：`{ "type", "apiBaseUrl", "apiKey" }` → `{ "ok", "models": ["…"] }`；端点与联通测试同源（api `/models`、dashscope `/compatible-mode/v1/models`、gemini `/v1beta/models` 去 `models/` 前缀；minimax 为 best-effort 试 `/v1/models`），失败返回 `{ "ok": false, "error" }`，前端保持手填。
- `POST /api/enhance-prompt` → 提示词加强（设置页配置的加强模型，OpenAI 兼容 `chat/completions`，系统模板内置于服务端）：`{ "enhancerId"?, "prompt", "style"?, "mediaKind"?, "referenceImageCount"? }` → `{ "enhanced", "enhancerName" }`。`style` 选择像素/动漫/插画/3D/写实/不限风格的规则与示例；`mediaKind` 区分图片和视频；`referenceImageCount`（0–10）区分文生、单引用图和按 Image 1…N 排序的多引用图语义。前端传入当前选择，选择变化时清除旧对比；聊天回答或澄清问题会自动纠正一次，仍无效则明确报错。
- `GET /fonts/:name` → `apps/web/public/fonts/` 下的字体文件（woff2 / OFL.txt）
- `GET /imageops/imageOps.worker.js` → 前端剪裁 worker 脚本（服务端按需 `Bun.build` 打包 `apps/web/src/imageops/imageOps.worker.ts` 下发；开发模式每次重建，生产缓存）

## MCP（Model Context Protocol）端点

FrameBaker 内置 MCP 服务端，允许 AI 助手（Claude Desktop / Cursor / Windsurf 等）通过 MCP 协议操作项目、帧、素材、任务等全部功能。

### 传输

基于 `@modelcontextprotocol/server` SDK v2 的 Streamable HTTP 传输，自动兼容 2025-era（`initialize` 握手）和 2026-07-28（无状态核心）协议版本。

- `POST /mcp`：接收 JSON-RPC 请求，返回 JSON 响应
- `GET /mcp`：SSE 通道（服务端→客户端通知）
- `DELETE /mcp`：结束会话

协议版本协商、会话管理均由 SDK 自动处理，全部工具为无状态直接 db 操作。

### 客户端配置

**Claude Desktop**（macOS `~/Library/Application Support/Claude/claude_desktop_config.json`，Windows `%APPDATA%\Claude\claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "framebaker": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Claude Code**（CLI）：

```bash
claude mcp add framebaker --transport http http://localhost:3000/mcp
```

**Cursor**（项目根目录 `.cursor/mcp.json` 或全局设置）：

```json
{
  "mcpServers": {
    "framebaker": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Windsurf**（`~/.codeium/windsurf/mcp_config.json`）：

```json
{
  "mcpServers": {
    "framebaker": {
      "serverUrl": "http://localhost:3000/mcp"
    }
  }
}
```

### 快速接入提示

复制以下内容发给你的 AI 助手即可开始使用：

```
FrameBaker 正在 http://localhost:3000 运行，MCP 端点为 /mcp（Streamable HTTP）。
请连接并调用 list_projects 开始。
可用工具：list_projects、create_project、list_frames、generate_frames、list_materials、matting_material、list_jobs、get_config 等共 48 个。
覆盖功能：像素动画项目、帧、素材、AI 生成、抠图、文件夹、任务与系统设置。
```

### 握手（2025-era 客户端）

```json
// 请求
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "my-client", "version": "1.0" } } }
// 响应
{ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18", "capabilities": { "tools": {} }, "serverInfo": { "name": "framebaker", "version": "0.5.0" } } }
```

握手后发送 `notifications/initialized` 通知（无需响应），随后可 `tools/list` 和 `tools/call`。2026-07-28 客户端无需握手，直接调用即可。

### 工具列表

| 工具 | 说明 |
| --- | --- |
| `list_projects` | 列出全部项目 |
| `get_project` | 获取单个项目详情 |
| `create_project` | 创建项目 |
| `update_project` | 更新项目名/文件夹 |
| `delete_project` | 删除项目及其帧/任务/文件 |
| `list_frames` | 列出项目全部帧 |
| `update_frame` | 更新帧图片属性/变换 |
| `delete_frame` | 删除帧 |
| `clear_frame_cell` | 清空时间轴单元格但不删除可复用资产文件 |
| `get_timeline` | 获取轨道、步骤、图片单元格和独立特效单元格 |
| `upsert_attack_effect` | 在任意轨道×步骤单元格创建或替换攻击特效 |
| `duplicate_frame` | 复制帧 1–16 份 |
| `reorder_frames` | 重排帧顺序 |
| `generate_frames` | 为项目生成帧（AI provider） |
| `generate_materials` | 生成素材（AI provider） |
| `list_materials` | 列出全部素材 |
| `rename_material` | 重命名单个图片或视频素材 |
| `matting_material` | 单素材抠图 |
| `split_material_layers` | 使用独立图片分层服务拆分素材图层 |
| `batch_matting` | 批量抠图 |
| `extract_material_frames` | 视频/GIF 素材抽帧 |
| `import_material_to_project` | 素材导入为项目帧 |
| `batch_import_materials` | 批量素材导入项目 |
| `batch_delete_materials` | 批量删除素材 |
| `unmatting_material` | 还原图（删除抠图结果） |
| `list_folders` | 列出文件夹 |
| `create_folder` | 创建文件夹 |
| `update_folder` | 更新文件夹 |
| `delete_folder` | 删除文件夹（内容上移） |
| `move_items_to_folder` | 移动素材/项目到文件夹 |
| `list_jobs` | 列出最近任务 |
| `get_job` | 查询单个任务状态 |
| `cancel_job` | 取消任务 |
| `get_config` | 获取服务端配置（provider/抠图引擎） |
| `run_doctor` | 体检 |
| `get_settings` | 获取全部设置 |
| `update_setting` | 更新单个设置项 |
| `enhance_prompt` | 提示词加强 |

### 工具调用示例

```json
// 列出项目
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "list_projects", "arguments": {} } }

// 创建项目
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "create_project", "arguments": { "name": "走路循环" } } }

// 生成帧
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "generate_frames", "arguments": { "projectId": "…", "prompt": "pixel art knight walk cycle", "count": 4 } } }

// 查询任务状态
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "get_job", "arguments": { "jobId": "…" } } }
```

工具返回 `content: [{ type: "text", text: "…" }]` 格式（text 为 JSON 字符串）；错误时 `isError: true`。
