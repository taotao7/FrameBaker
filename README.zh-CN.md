# FrameBaker

**像素风逐帧动画编辑器 —— Bun 全栈应用。**

多来源素材导入（GIF/MP4 拆帧、PNG 上传、外部 CLI 生成），内置 rembg 抠图引擎一键去背，在素材库里对比确认效果，再用 PixiJS 洋葱皮编辑器逐帧调整，时间轴排序，播放预览，最后导出精灵表（spritesheet）。

> ✅ **多轴 / 多轨 MVP 已交付：**支持动画变体、合成轨道、共享步骤、合成预览与导出，并提供骨骼绑定、角色上动作编辑与部件自由变形能力。

![Bun](https://img.shields.io/badge/Bun-1.3-14151A?logo=bun)
![Elysia](https://img.shields.io/badge/Elysia-1.4-6f61c0)
![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)
![核心单测覆盖率](https://img.shields.io/badge/%E6%A0%B8%E5%BF%83%E5%8D%95%E6%B5%8B%E8%A6%86%E7%9B%96%E7%8E%87-100%25-brightgreen)
![License](https://img.shields.io/badge/License-MIT-green)

[English](README.md) | **中文**

![播放预览演示](docs/media/demo.gif)

### 骨骼动作工作流

先用部件组装角色，再在当前角色上直接制作动作：在画布上拖骨骼关节或部件控制点网格，按轨道为位移/旋转/缩放/弯曲/自由变形打关键帧，并在项目画板上实时预览效果。

| 动作制作工作区与实时预览 | 在当前角色上编辑动作 |
| --- | --- |
| ![带实时预览的骨骼动作工作区](docs/media/skeletal-action-workspace.png) | ![在当前角色上编辑动作](docs/media/skeletal-action-editor.png) |

![动作时间轴上的逐骨骼与逐部件关键帧轨道](docs/media/skeletal-action-timeline.png)

### 人物骨骼分件工作流

基于角色参考图生成并抠出人物分件表，再通过逐格移动、直接拖动分隔线、合并/细分、质量检查和逐格擦除编辑完成网格校正，最后创建骨骼部件素材。

| 人物分件素材 | 可交互分件网格编辑器 |
| --- | --- |
| ![生成并抠图后的人物分件素材](docs/media/skeletal-parts-preview.png) | ![可交互人物骨骼分件网格编辑器](docs/media/skeletal-grid-editor.png) |

| 帧编辑器 | 素材库 |
| --- | --- |
| ![帧编辑器](docs/media/editor.png) | ![素材库](docs/media/library.png) |

| 播放预览 | 深色主题（Magnetic Night） |
| --- | --- |
| ![播放预览](docs/media/preview.png) | ![深色主题](docs/media/library-dark.png) |

| 视频素材（自定义像素风播放器） | 抽帧编辑器（VIDEO CUT LAB） |
| --- | --- |
| ![视频素材详情](docs/media/video-material.png) | ![抽帧编辑器](docs/media/video-cut-lab.png) |

## 场景分层演示

场景分层将一张扁平图片重建成多个可独立编辑、隐藏和移动的 RGBA 图层。下面的演示素材在 FrameBaker 素材库中使用 `wan2.7-image` 生成，再由独立配置的 `Qwen-Image-Layered` 以 **4 层 / 50 步 / CFG 4** 实际分解。

| 生成的扁平场景 | 场景分层结果 |
| --- | --- |
| ![月夜炼金师场景原图](docs/media/scene-layering-source.png) | ![背景、道具、地面与完整角色图层](docs/media/scene-layering-layers.png) |

- **L1 背景**：夜空与城堡；**L2 道具**：水晶、药水和宝箱；**L3 地面**：草地平台；**L4 主体**：保持完整的炼金师角色与月亮。
- 这是语义图层重建，不是严格的像素标签分割：模型可能把月亮与角色放在同层，也可能让同类元素跨层，但各层可以独立合成和编辑。
- **场景分层不承诺把人物拆成头、躯干和四肢。**角色骨骼拆件属于另一套蒙版/分割工作流，不应拿场景分层结果冒充。
- 完整场景默认不先抠图，以保留背景和景深信息；仅在需要继续细分已独立前景时手动勾选「抠图去背」。

**原场景与四个分层产物在素材库中的实际展示：**

![场景分层产物在素材库中的展示](docs/media/scene-layering-library.png)

## 特性

- **多来源导入** —— ffmpeg 拆 GIF/MP4 帧（fps 可调）、PNG 多选上传、外部生成 CLI（`FRAMEBAKER_GEN_CLI`）
- **视频素材与抽帧编辑器** —— 生成/上传的视频素材自带自定义像素风播放器（棋盘背景、点击播放暂停、主题进度条）；「VIDEO CUT LAB」抽帧编辑器可拖动进度条精确取帧，也可设置区间+fps 批量打点，一次最多抽取 64 帧图片素材（可在抽帧同时顺带抠图）
- **内置抠图** —— rembg 开箱即用（默认 u2net，可换模型）；也支持自定义 CLI 模板；前后对比滑杆验收去背效果
- **场景分层** —— 独立 Qwen-Image-Layered 配置，把扁平图拆成背景、完整主体、道具和前景等 RGBA 层；支持递归细分，但不冒充人物肢体拆件
- **素材库** —— 一级暂存区：生成/上传 → 抠图 → 对比 → 导入任意项目，支持单个与批量
- **帧编辑器** —— PixiJS v8 画布：洋葱皮、网格、视图缩放、拖拽偏移、图片缩放/旋转/透明度、剪裁替换、帧时长与关键帧
- **时间轴与批量操作** —— 拖拽换序，Cmd/Ctrl+点击与 Shift+点击多选，批量删除/复制/统一时长
- **人形动作骨架** —— 选择采样为 8–16 帧的 CC0 Quaternius Universal Animation Library 现成动作后立即播放，可整段调节动作幅度、手臂摆幅、腿部步幅、身体起伏和前倾，再按需逐帧微调 FK 关节并导出姿态表
- **精灵表导出** —— 纯前端 canvas 拼合，帧变换烘焙到对齐单元格 → `*.spritesheet.png` + `*.json`
- **Cassette Futurism 双主题** —— 深色 Magnetic Night / 浅色 Beige Terminal；默认跟随系统，三态切换（跟随系统/浅色/深色）
- **实时同步** —— WebSocket 广播任务进度与帧/素材变更
- **可调布局** —— 拖拽分隔条调整帧列表宽度与时间轴高度（自动持久化）
- **MCP 服务端** —— 内置 [Model Context Protocol](https://modelcontextprotocol.io) 端点（`POST /mcp`，Streamable HTTP），暴露 48 个工具，让 AI 助手（Claude Desktop、Cursor、Windsurf）程序化管理项目、帧、素材、生成、抠图、任务与设置

## 系统要求

- **Windows 10/11、macOS 或 Linux** —— Windows 已在真机通过服务启动、前端加载、API、SQLite 存储及 ffmpeg 体检验证
- **Bun 1.3+** —— 必需；安装后需重新打开终端，确保 `bun --version` 可用
- **ffmpeg** —— 仅 GIF/MP4 拆帧需要，PNG 导入和其他编辑功能不依赖它
- **uv（推荐）或 Python 3** —— 仅安装内置抠图引擎时需要；uv 可自动下载隔离的 Python，无需预装系统 Python
- 支持 WebGL 的现代浏览器（PixiJS v8 画布）

### Windows 前置环境（PowerShell）

```powershell
# 1. 安装 Bun（也可参考 https://bun.sh/docs/installation）
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. 安装 ffmpeg（需要 GIF/MP4 拆帧时）
winget install ffmpeg

# 3. 安装 uv（需要抠图时；也可改装 python.org 的 Python 并加入 PATH）
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# 安装后重新打开 PowerShell 并验证：
bun --version
ffmpeg -version
uv --version
```

> `setup_matting.ps1` 优先使用 uv 创建 Python 3.12 隔离环境；没有 uv 时才回退 PATH 中的 Python。Microsoft Store 的 `python.exe` 应用执行别名不等同于已安装 Python。

## 快速开始

```bash
bun install
bun dev          # 开发模式（--hot）→ http://localhost:3000
# 或
bun start        # 生产
```

- 拆帧依赖 ffmpeg：`brew install ffmpeg`（macOS）/ `winget install ffmpeg`（Windows）
- **抠图引擎**（可选；每个新环境只需安装一次）：
  ```bash
  ./scripts/setup_matting.sh            # macOS / Linux（CPU，默认）
  ./scripts/setup_matting.sh --gpu      # macOS / Linux（NVIDIA GPU，onnxruntime-gpu）
  # Windows（PowerShell）：
  powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1           # CPU
  powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1 -Gpu      # GPU
  ```
  创建 `.venv-matting/` 并安装 `rembg[cli,cpu]`（或 `rembg[cli,gpu]`）；Windows 上优先使用 uv 管理 Python 3.12。u2net 模型在首次抠图时自动下载到 `storage/models`。不安装则抠图退化为 passthrough（复制原图并给出警告）。

  **GPU 模式**需要 NVIDIA 显卡和匹配版本的 CUDA Toolkit。`onnxruntime-gpu` 版本必须与 CUDA 版本对应（如 onnxruntime-gpu 1.16 ↔ CUDA 11.8，1.17+ ↔ CUDA 12.x）。如果遇到 DLL 加载错误，请检查 CUDA 是否安装且版本匹配。CPU 和 GPU 之间切换：删除 `.venv-matting/` 后用对应参数重新运行脚本。
- 类型检查：`bun run typecheck`
- 单元测试：`bun run test`
- 核心单测覆盖率报告：`bun run test:coverage`（当前覆盖共享规则、帧几何与 ZIP 导出）

### Windows 注意事项与常见问题

项目在 Windows 上可以正常运行，但有几个平台相关的坑需要注意：

1. **`bun dev` 使用 `--watch` 而非 `--hot`** —— Bun 1.3 在 Windows 上的浏览器 HMR 会打乱 PixiJS 8 循环依赖的初始化顺序，导致画布空白。因此 dev 脚本改用 `--watch`（服务端文件变化自动重启，但前端不 HMR）。**前端改动后需要手动刷新浏览器**。macOS/Linux 仍保留完整 HMR。

2. **PixiJS 从 CDN 加载，不走 npm 包** —— `apps/web/index.html` 通过 `<script>` 标签引入 `cdn.jsdelivr.net/npm/pixi.js@8.19.0/dist/pixi.min.js`，绕过 Bun 打包器对 PixiJS 循环 import 的错误处理。首次加载需要能访问 `cdn.jsdelivr.net`，之后使用浏览器缓存。如需离线使用，可将 `pixi.min.js` 下载到 `apps/web/public/` 并修改 `<script>` 路径。

3. **服务端 dev 模式在 Windows 上被禁用** —— `apps/server/src/index.ts` 在 `win32` 下设 `development: false`，阻止 Bun 的 HTML dev server 注入会触发同样 PixiJS 问题的 HMR 脚本。不影响生产模式（`bun start`）。

4. **每次拉取或依赖变更后必须 `bun install`** —— Bun 的隔离式 workspace 布局意味着本地 `@framebaker/shared` 包只有在 `bun install` 后才能解析。跳过这一步，Bun 可能从全局缓存加载第三方包，却无法解析 workspace，导致 import 报错。

5. **PowerShell 环境变量语法** —— 用 `$env:PORT=8080; bun dev`（分号分隔，不是 `&&`）。旧版 PowerShell 不支持 `&&` 操作符。macOS/Linux 用 Bash 语法 `PORT=8080 bun dev`。

6. **PowerShell 脚本执行策略** —— `setup_matting.ps1` 需要 `-ExecutionPolicy Bypass`（如 `powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1`）。脚本以纯 ASCII 编写，兼容 Windows PowerShell 5.1（无需 UTF-8 BOM）。

7. **Microsoft Store 的 `python.exe` 不是真正的 Python** —— Windows 自带的「应用执行别名」`python.exe` 会打开 Microsoft Store 而非运行 Python。请从 [python.org](https://www.python.org/downloads/) 安装（勾选「Add to PATH」），或安装 [uv](https://docs.astral.sh/uv/)（可自动下载隔离 Python，无需系统安装）。`setup_matting.ps1` 优先使用 uv，仅在没有 uv 时才回退 PATH 中的 Python。

8. **Windows 脚本路径用反斜杠** —— 在 PowerShell 或 cmd 中运行脚本时用 `scripts\setup_matting.ps1`，不要用正斜杠 `scripts/setup_matting.ps1`。

## 抠图引擎解析顺序

服务按需实时探测（可用 `GET /api/config` 查看）：

1. `FRAMEBAKER_MATTING_CLI` —— 自定义命令模板（占位符 `{input}` `{output}`，可选 `{model}`）
2. `<repo>/.venv-matting` 内置 rembg（POSIX 为 `bin/rembg`，Windows 为 `Scripts/rembg.exe`）—— 由 `scripts/setup_matting.sh` / `setup_matting.ps1` 安装（engine = `rembg-bundled`）
3. PATH 中的 `rembg`（engine = `rembg-path`）
4. 都没有 —— passthrough 复制原图并提示安装（engine = `none`）

rembg 调用形式为 `rembg i -m <MODEL> input output`；模型默认 `u2net`，统一缓存在 `storage/models`（自动注入 `U2NET_HOME`）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 `3000` |
| `FRAMEBAKER_GEN_CLI` | 生成 CLI 模板，占位符 `{prompt}` `{output}` `{index}` `{reference}`。例：`FRAMEBAKER_GEN_CLI='mygen --prompt "{prompt}" --ref {reference} -o {output}' bun dev`。`{reference}` 为界面里选择的引用图（素材或项目帧，服务端按 id 解析路径防注入）——选了引用图但模板缺 `{reference}`，或模板有 `{reference}` 但没选，创建任务时直接 400 |
| `FRAMEBAKER_MATTING_CLI` | 自定义抠图 CLI 模板，占位符 `{input}` `{output}`（可选 `{model}`），优先于内置 rembg |
| `FRAMEBAKER_MATTING_MODEL` | rembg 模型名，默认 `u2net`（如 `birefnet-general-lite`、`isnet-general-use`） |

## 项目结构

Bun workspaces monorepo：

- `apps/server`（@framebaker/server）—— Elysia API + 内存任务队列 + bun:sqlite；经 Bun HTML import 托管前端
- `apps/web`（@framebaker/web）—— React 19 + pixi.js v8 + motion + lucide-react
- `packages/shared`（@framebaker/shared）—— 前后端共享类型与常量
- `scripts/` —— 安装脚本与统一 SemVer 版本管理脚本
- `docs/` —— 文档，包括独立的[变更日志](docs/CHANGELOG.zh-CN.md)
- `storage/` —— 运行时数据（SQLite、帧、素材、rembg 模型；已 gitignore）

## 文档

- [docs/guide.zh-CN.md](docs/guide.zh-CN.md) —— 使用指南（设置页、provider 配置、剪裁工具、素材加工、编辑器）
- [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) —— 架构图、模块说明、数据流、存储布局
- [docs/api.zh-CN.md](docs/api.zh-CN.md) —— API 一览（含请求/响应示例）、WS 事件、MCP 端点
- [docs/roadmap.zh-CN.md](docs/roadmap.zh-CN.md) —— 已完成清单与后续规划
- [docs/CHANGELOG.zh-CN.md](docs/CHANGELOG.zh-CN.md) —— 按版本记录功能与 Bug 修复
- [docs/VERSIONING.zh-CN.md](docs/VERSIONING.zh-CN.md) —— main 发布使用的 `MAJOR.WEEK.BUG` 规则

## MCP（AI 助手集成）

FrameBaker 内置 MCP 服务端，让 AI 助手通过 [Model Context Protocol](https://modelcontextprotocol.io) 控制全部功能。

**端点：** `POST /mcp`（Streamable HTTP，JSON-RPC 2.0，协议版本 `2024-11-05`）

启动服务（`bun dev` 或 `bun start`），然后在 AI 客户端中配置：

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

**Claude Code**（CLI）：`claude mcp add framebaker --transport http http://localhost:3000/mcp`

**Cursor**（`.cursor/mcp.json`）：`{ "mcpServers": { "framebaker": { "url": "http://localhost:3000/mcp" } } }`

**Windsurf**（`~/.codeium/windsurf/mcp_config.json`）：`{ "mcpServers": { "framebaker": { "serverUrl": "http://localhost:3000/mcp" } } }`

服务端暴露 **48 个工具**，覆盖项目、帧、素材、生成、抠图、文件夹、任务与系统配置。完整工具列表与调用示例见 [docs/api.zh-CN.md](docs/api.zh-CN.md)。

## 许可

[MIT](LICENSE) © 2026 taotao7

界面字体为 **Fusion Pixel 12px**（`apps/web/public/fonts/`），采用 SIL Open Font License 1.1 —— 详见 `apps/web/public/fonts/OFL.txt`。

### 致谢与第三方项目

- [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html)（Quaternius，CC0 1.0 Universal）—— FrameBaker 从 Standard GLB 抽取、正交投影并重定向 `Idle_Loop`、`Walk_Loop`、`Sprint_Loop`、`Sword_Attack`、`Hit_Chest`、`Death01`、`Jump_Start` 和 `Jump_Land`，转换为内置二维局部旋转动作；跳跃预设把起跳和落地片段组合为紧凑的游戏动作轨迹，本仓库不打包原始 GLB。
- [huchenlei/sd-webui-openpose-editor](https://github.com/huchenlei/sd-webui-openpose-editor)（Chenlei Hu，MIT License）—— 动作工作台设计时评估了其姿态操作流程与 COCO-18 约定；最终简单工作流没有嵌入该专业编辑器，本仓库也未打包其源码。
- [ZhUyU1997/open-pose-editor](https://github.com/ZhUyU1997/open-pose-editor)（Yu Zhu，MIT License）—— 逐关节微调交互参考了其变换 gizmo 与姿态预览流程；本仓库未打包其源码。

## 已知限制

任务队列在内存中（重启丢未完成任务）；GIF 拆帧忽略帧延迟；单图导入按字节落盘（建议 PNG）；精灵表不做 trim；无鉴权仅限本地。改进计划见 [roadmap](docs/roadmap.zh-CN.md)。

<!-- latest-changelog:start -->
## 最近更新

### [0.5.0](docs/CHANGELOG.zh-CN.md#050---2026-09-02) · 2026-09-02

#### 新增

- 图片素材新增基于 imageops worker 的色键抠图：支持画布吸管取色、主色色盘、0–255 切比雪夫容差、可选边缘过渡、实时预览，以及保留源图的单张或批量应用。
- 所有生成弹窗新增可选纯色垫底图：支持高对比预设色、自定义颜色与基于素材主色的自动推荐；服务端通过 ImageMagick 临时合成引用图，绝不修改源素材或项目帧。

#### 移除

- 移除了参考图拆分中的目标骨架选择器：它只影响生成提示词与网格行列，下游切分、命名与绑定均不消费，且 `targetSkeletonId` 从未被服务端接收；拆分网格恢复为手动行列 + 人形默认值。

### [0.4.0](docs/CHANGELOG.zh-CN.md#040---2026-08-20) · 2026-08-20

#### 新增

- 角色绑定编辑器新增项目级关节角度修正：逐骨骼基础旋转随角色持久化，并统一应用于静止姿势、所有动作及 `.fbanim` 导出，不会修改共享骨架资产。
- 新增确定性的柔性附件变形：披风等软性部件支持画布弯曲拖拽，以及静态弯曲、播放摆幅、方向、频率和相位控制。
- 新增完整人物骨骼分件表工作流：支持逐格取图、直接拖动分隔线、矩形合并、右键横向/纵向细分、质量门禁预览，以及入库前逐部件擦除编辑。
- 骨骼切分弹窗新增连通域自动检测：按不透明块逐个识别为部件单元（阅读顺序排列），避免均匀网格切穿部件；检测出的每格仍可微调、切分、合并与命名。
- 新增人形骨架语义诊断与自动组装的共享层能力及测试（尚未接入界面）。
- 骨骼绑定的素材图片选择器新增文件夹筛选，支持多级目录路径以及“全部”和“未分组”视图。
- 素材库右键菜单、REST API 与 MCP 工具新增素材重命名，并立即同步当前打开的素材视图。
- 补齐图片素材右键菜单，可直接进入剪裁、逐帧/骨骼切分、人物拆分、多动作/八方向生成、还原抠图、导入、场景分层、自动裁边、导出与删除。
- 动作事件支持输入、校验并查看可选 JSON payload，数据随 MotionClip 持久化。
- 新增 MotionClip schema v2：逐片段 cubic-bezier 时间曲线、显式无损 v1 迁移、四元数缓动 slerp、曲线编辑及 `.fbanim`/光栅烘焙兼容。
- 部件新增自由变形：绑定编辑器中可为部件启用可拖拽的控制点网格（2×2/3×3/4×4）做静态变形，动作时间轴上的 `att:` warp 轨道以同样的网格增量打关键帧；变形位图按确定性光栅化（最近邻取样）生成，合成顺序在弯曲滤镜之前，并完整支持 `.fbanim` 导出再导入。

#### 调整

- 内置人形骨架及关节名称现会在骨架选择、动作编辑、画布提示、时间线和角色绑定中随界面语言切换，自定义名称仍保持用户原文。
- 优化人物分件提示词：用户指定的网格仅代表容量，允许多余透明格和超大部件占用连续矩形多格，并禁止为填满网格虚构部件或武器。
- 拖动分隔线时仅调整当前格及该边界正对的关联格，左右其他格不再随整条分隔线一起变化。
- 骨骼项目统一只输出 `.fbanim` 运行时包，移除逐帧项目兼容烘焙线路、RenderProfile 与 RasterSequence API。

#### 修复

- 选中附件的变换框现会直接接管画布拖动，重叠部件不再把弯曲或变换操作错误转移到其他图层。
- 橡皮擦拖出编辑画布时现会一直擦到图片实际边界，同时质量检查不再把几乎透明的抗锯齿残留误报为分件贴边。
- 修复骨骼项目编辑器不感知动作资产保存的问题：动作页签的实时预览画板与角色页签的骨骼/绑定视图现订阅 `animation_assets_changed`，动作编辑弹窗（或其他页面）一旦保存即重新拉取当前动作、骨架与资产列表。

[查看完整变更日志 →](docs/CHANGELOG.zh-CN.md)
<!-- latest-changelog:end -->
