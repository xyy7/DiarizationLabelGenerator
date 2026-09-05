# 说话人稳定音频与声纹相似度改判 技术方案

**日期**：2026-08-29
**状态**：已实施完成（2026-08-29 实现、08-31 修复轮收尾；实现与验收见 `docs/HANDOFF.md` 第八节，任务记录在 `tasks/2026-08-29/`，不入 git）
**上游意图**：[docs/intent/speaker-similarity.md](../intent/speaker-similarity.md)
**关联**：[docs/intent/adg-refactor.md](../intent/adg-refactor.md)

> 意图书里列为"未决定"的 6 个问题均在本方案内决策，决策从第 2 节开始。

---

## 0. TL;DR

新增一个 `verify` 服务（镜像复用 worker 层，独立进程），加载 eres2net 模型，**算说话人声纹相似度并把结果缓存进数据库**；API 加一个同步端点给前端"自动识别"面板喂数；前端在时间轴上右键片段 → "自动识别" → 侧边面板按相似度排各说话人（每段稳定音频可试听 + 百分比），勾选 1~N 个说话人确认改判，**勾多个 = 重叠讲话，存成两段同时间不同说话人的 segment**。

- 重叠存储：**两段同时间、不同 speaker（版本 A）**，与 DiariZen 自身 powerset 输出的既有表象一致，RTTM 导出天然正确。
- 部署：新 `verify` 容器（worker 镜像 `FROM worker AS verify`），GPU 做成构建参数 + 运行参数；API 永不装 torch。
- 缓存：embedding 按**音频内容**（时间范围）键控，模型版本带在行上，时间一改动自动失效。
- 前端：右键菜单 + antd Drawer 面板；面板内独立 `<audio>` 播放；改判是本地纯函数操作，进入既有 undo / 自动保存管线。

---

## 1. 架构总览

```
浏览器 ──► api (FastAPI, 无 torch)  ──► /api/recordings/{id}/similarity（同步）
                │                        │
                │                        ▼
                │                 verify:8001（torch + eres2net, 新容器）
                ▼                        │
            Postgres ◄── embedding 缓存 ──┘
   /data/audio/{id}/audio.wav（16k 单声道，api/verify 只读）
```

- **worker 完全不动**：DiariZen 职责不扩展；GPU 加速在 verify 容器内生效，不碰 DiariZen 的 CPU 推理结构（意图书约束至今有效）。
- verify 是唯一持有 eres2net 权重并做浮点运算的进程；api 只做编排（读标注、拼响应、错误映射）。

---

## 2. 六个未决问题的决策

### 2.1 重叠标注的存储形态 → 两段同时间不同 speaker（不引入多对多）

理由：

1. **已经就是这样表达的**。`segments` 无排他冲突约束（`migrations/versions/0001_baseline.py` 中 segments 定义处明确注释"overlap 不是脏数据"），DiariZen powerset 输出就允许两段同时间不同 speaker；RTTM 导出按 `(start, label)` 排序即天然多层重叠（`domain.py:144-158`），md-eval / dscore 均支持。
2. **部分重叠可以表达**（A [1.0,3.0]、B [1.5,2.5] 各自独立），一对多复合模型做不到。
3. 改判动作语义简单：**一个 segment 替换成 N 个同时间范围的 segment（N=勾选数）**。原始 segment 的 id 保留给勾选集合中"恰好是原说话人"的那份，其余为新行——id 稳定，undo 照常。

代价：一个多说话人区域在时间轴上表现为两条 lane 上各有一个方块，调整边界时需拖动两个。接受：重叠区域的边界本就是人耳无正确答案的区域，修正频率低。

### 2.2 eres2net 部署位置 → 新 `verify` 容器

- **被否方案 A：装进 api** —— 违反 "api 镜像刻意无 torch"（`Dockerfile:1-6` 注释与 `pyproject.toml:7-9` 的自我约定），且 55M 模型进轻量进程损害并发。
- **被否方案 B：走 worker 任务队列** —— 右键要秒级，队列 + 轮询打死交互。
- **方案：`FROM worker AS verify` 新 stage**。同一镜像多一个轻量入口（uvicorn:8001），复用现有 torch、PyAV、soundfile 依赖；新增 `modelscope` 安装只进 verify stage。api 通过 `VERIFY_URL`（默认 `http://verify:8001`）同步调用。

embedding 计算路径：verify 启动即加载模型（lifespan warmup，与 worker `get_pipeline()` 同风格），每段 2~5s 音频 CPU 全流程 ≈ 1~3s（ONNX 实测 RTF 0.42；torch 稍逊，可接受）。

### 2.3 相似度语义与展示

- 评分 = 余弦相似度，embedding 先 L2 归一化；展示值 `score = max(0, cos) × 100`，四舍五入取整 → 「90% / 83%」。
- 排序基准：说话人行取**该说话人各稳定片段最高分**；行内照实列出每段稳定片段的分数（顺序按稳定音频自身的时间序）。
- 不裁剪 top-N：单条录音说话人数量少（2~8），全列。
- 面板分组：有稳定音频的说话人按分数降序；无稳定音频的说话人底部单独列出（灰置、勾选框禁用，tooltip「该说话人尚未设置稳定音频」）。当前说话人**包含**在排序中（带「当前」徽标，防误杀）。
- 绝对分数仅作参考，人耳试听为主（意图书：对工具的价值在排序 + 可试听，不在绝对精度）。

### 2.4 稳定音频标记与缓存失效

- `segments` 加列 `is_stable BOOLEAN NOT NULL DEFAULT FALSE`，随整文档 PUT 一起保存（现有 whole-doc save 路径零改动，只是字段多一个）。
- 新表 `segment_embeddings` 按**音频内容**键控：

```sql
CREATE TABLE IF NOT EXISTS segment_embeddings (
    recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    start_sec    DOUBLE PRECISION NOT NULL,
    end_sec      DOUBLE PRECISION NOT NULL,
    model_id     TEXT NOT NULL,
    embedding    JSONB NOT NULL,          -- 192 个 float
    computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (recording_id, start_sec, end_sec)
);
```

- **失效规则只有一条**：访问时若行缺失、或 `model_id != 当前模型版本常量`、或该行 `(start_sec, end_sec)` 与被查段当前时间范围不等 → 重算补写。
  - 边界拖动 / 拆分合并 → 时间变 → 自然重算；
  - **改判说话人不失效**（embedding 只依赖音频内容，不依赖标签）；
  - 同一时间的多个说话人（重叠）共享同一行缓存——内容相同，正确且省钱；
  - `text` 变化不失效。
- 计算时机（双保险）：
  1. **预计算**：`save_annotation` 成功后 API 向 verify fire-and-forget 一个 precompute（只算 `is_stable` 且缺失/过期者，几条，秒级）；
  2. **惰性**：similarity 请求内，稳定片段缓存缺失时当场补齐（首次点击的最坏情况 = 全部缺失，2~5 条 × 1~3s；正常标记后点击仅算 query 一条）。

### 2.5 模型下载与 CUDA

- **下载**：扩展 `diarizen-config/download_models.py`，新增 ModelScope 条目，沿用 `requests` 流式 + 断点续传模式。URL 形态（实现时以 repo API 核验两者之一）：
  - `https://modelscope.cn/models/iic/speech_eres2net_sv_zh-cn_16k-common/resolve/master/<file>`
  - 或 `https://modelscope.cn/api/v1/models/iic/speech_eres2net_sv_zh-cn_16k-common/repo?Revision=master&FilePath=<file>`
  - 文件：`pytorch_model.bin` + 配置（`configuration.json` / `am.json` / `input.json`，按仓库实际），落地 `models/eres2net-sv-zh-cn-16k-common/`。
  - 注意：modelscope.cn 直连即可（免代理）；若部署机走 Clash，需走绕过 CN 域名的规则。license 同为 CC BY-NC 4.0，与 DiariZen 一致，README 许可节补充一句。
- **CUDA**：
  - 构建参数 `ARG TORCH_VARIANT=cpu`：`--build-arg TORCH_VARIANT=cpu`（默认，`whl/cpu` 现货镜像）或 `cu118`（torch 2.1.1 对应 CUDA 11.8）。`RUN pip install --index-url https://download.pytorch.org/whl/${TORCH_VARIANT} torch==2.1.1 torchvision==0.16.1 torchaudio==2.1.1`。
  - 运行时参数 `EMBEDDING_DEVICE=auto|cpu|cuda`（默认 `auto`）：`auto` = `torch.cuda.is_available()` 实测决定。GPU 机器 `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d verify`（override 文件附 `gpus: all` + `build.args.TORCH_VARIANT=cu118`）。
  - worker（DiariZen）维持 CPU，不在本期作用域。

### 2.6 与既有动作的协作

- 右键菜单（新）：`自动识别相似度…` / `设为稳定音频`（已设则为`取消`） / 分隔 / `删除该段`；单击选中 + 键盘操作完全不动。
- 面板确认 → 本地纯函数 `reassignToSpeakers(seg, labels[])` → 走进既有 `commit()`（undo/redo 快照、2s 防抖自动保存、version 冲突弹窗）——**不另做后端 CRUD**。
- `1`–`9` 单说话人改判保留（最常用路径，不开面板）。
- 新增快捷键 `i`：选中段直接打开识别面板（右键之外的快捷入口），Esc 关闭面板。

---

## 3. 数据库变更

当时的 `schema.sql` 追加（幂等，现并入迁移 `0001_baseline`）：

```sql
ALTER TABLE segments ADD COLUMN IF NOT EXISTS is_stable BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS segment_embeddings ( ...见 2.4... );
```

同步改动：

| 文件 | 改动 |
|---|---|
| `server/app/models.py` | `Segment.is_stable: Mapped[bool]`；新增 `SegmentEmbedding` ORM（`recording_id/start_sec/end_sec/model_id/embedding/computed_at`） |
| `server/app/domain.py` | `SegmentIn.is_stable: bool = False`；其余规则不动（重叠本来合法，无需新校验） |
| `server/app/schemas.py` | `SegmentIO.is_stable: bool = False`；新增 `SimilarityResult` 等响应模型 |
| `server/app/annotations.py` | save/load 原样（whole-doc replace 自动携带新字段），无需逻辑改动 |

RTTM 导出/导入路径**零改动**：`is_stable` 不进入 RTTM（`rttm.py` 只关心 10 字段）；重叠段本来就可往返。

---

## 4. verify 服务

新包 `server/app/verify/`：

- `engine.py`：`@lru_cache get_engine()` —— 加载 modelscope sv 管线（本地目录 `settings.models_dir / "eres2net-sv-zh-cn-16k-common"`）；`set_num_threads(settings.torch_num_threads)`；设备按 `EMBEDDING_DEVICE`；`embed(wav_path, start, end) -> np.ndarray[192]`。**torch/modelscope 只在 `get_engine` 内导入**（与 `diarize.py:60-62` 同款延迟导入），保证无 torch 的 test 镜像也能导入本包测逻辑。
- `service.py`（纯逻辑，`embed` 以可注入函数进）：缓存查询/补写、L2 归一化、余弦、`max(0,cos)*100`、<0.8s 的段打 `short=True` 警告（不因此拒绝，评分仅供参考）。
- `server.py`：FastAPI app（verify_server 入口）：

```python
POST /similarity              # 内部
{ "recording_id": "...", "query": {"start_sec": 12.3, "end_sec": 15.0} }
→ { "items": [ {"label","name","color","best_score",
                "clips":[{"segment_id","start_sec","end_sec","score","short"}]} ],
    "unranked": [{"label","name","color"}],
    "elapsed_ms": 1234 }

POST /precompute              # 内部（fire-and-forget）
{ "recording_id": "..." } → { "computed": n, "skipped": m }

GET  /healthz
```

`/similarity` 内部实现：读 `store.load_annotation` → 取 `is_stable` 片段按说话人分组 → 逐条取/算缓存 → 算 query → 组响应。**注意：verify 读库里标注的当前版本；前端调用前会强制 save（见 6 节），保证稳定标志落库。**

- **接口契约（API → verify）**：API 从自身读标注只用于…… 否——为简化编排，verify 自己读标注（"同一个库、多个进程各司其职"与 worker 一致）。API 只做：鉴权 → 收 `{start_sec,end_sec}` → POST verify `/similarity` → 原样返回（含错误映射）。

模型常量化：`EMBEDDING_MODEL_ID = "eres2net-huge-zhcn-16k-common-v1"`（换模型/权重/代码任何影响向量的变更都 bump，即触发全量缓存重建）。

---

## 5. API 变更

`server/app/routers/annotations.py` 加一个端点：

```python
POST /api/recordings/{id}/similarity
body: { "start_sec": float, "end_sec": float }
→ SimilarityResult（同第 4 节响应）+ X-User-Name 鉴权（现有依赖）
错误：
  422 invalid        时间非法（end<=start、超出 duration）
  503 verify_unavailable   verify_url 无响应（未起 verify 容器 / 构建未完成）
```

- 调用侧配置：`settings.verify_url = os.environ.get("VERIFY_URL", "http://verify:8001")`；超时 60s（首次惰性补齐）→ 超时/连接失败统一 503。
- 后端渲染的 `Speakers/segments` 与 `SimilarityResult` 的严格校验：label 来自 DB 标注，不信任客户端；query 只取其时间（内容级定位，对 `tmp-N` 未保存段天然友好）。

---

## 6. 前端变更

| 文件 | 改动 |
|---|---|
| `ADG/src/types.ts` | `Segment.is_stable: boolean`；`SimilarityResult/SimilarityItem/SimilarityClip` 类型 |
| `ADG/src/annotation/operations.ts` | `toggleStable(seg)`；`reassignToSpeakers(seg, labels[])`（N=1 时与现有 `reassignSpeaker` 等价；N≥2 时原 segment 保留 id 给"原说话人在勾选集"那份，其余复制同时间范围的新段；原说话人不在集内则原行改挂第一个勾选标签、去重后余下各生成一行）；`tempId()` 继续用 |
| `ADG/src/annotation/reducer.ts` | 新 action `TOGGLE_STABLE`、`REASSIGN_MULTI`（都走 `commit()`，进 undo 历史）；重置 `notice` |
| `ADG/src/api/client.ts` | `similarity(id, start, end)` → `POST /recordings/{id}/similarity`；`X-User-Name` 复用 |
| `ADG/src/components/Timeline.tsx` | segment div 加 `onContextMenu` → 新 prop `onSegmentMenu(segment, x, y)`；稳定音频段渲染 ★ 徽标（`title="稳定音频"`）；新增 prop `onToggleStable` |
| `ADG/src/pages/Annotator.tsx` | `contextMenu` state（antd `Dropdown`，`trigger=['contextMenu']` 包 segment，或自有定位菜单：条目 = 自动识别 / 稳定音频开关 / 删除）；`i` 快捷键；`SimilarityPanel` 挂载：打开前 **dirty 则强制 save**（版本号不变则直接调）；面板回调 `onAssign(labels[])` → dispatch → 关闭 |
| `ADG/src/components/SimilarityPanel.tsx` | 新组件：antd `Drawer`（右侧、宽 ~360、带 mask）。**「▶ 播放本段」（识别对象）放在头部最显眼处，是耳边对照的基准点：面板打开即显示本段起止时间，先听本段，再挨个听候选片段（切换片段时本段可一键重听）；本段播放用面板自己的 `<audio>`（`currentTime=start`，Range 请求支持 seek，见 `recordings.py:121-130`），与主 wavesurfer 互不干扰**。列表：每行 color 点 + 说话人名 +「当前」徽标 + `best_score%` chip；展开行内容 = 各稳定片段 `[▶] 00:23–00:28 92%`（独立 `<audio>`，点击前停止其他播放，含本段）；行尾 checkbox 受「该说话人有稳定音频」门槛管控。底部：`改判给勾选的 N 个说话人` 主按钮（未勾选时禁用）/ `关闭`。加载态：识别中 spinner + 「首次识别约 1~3 秒（缓存补齐）」。错误态：503 → 说明未启动 verify。点击复选框时**替换**语义（defaultChecked 标签=原说话人，可取消勾选）。面板打开时 `ws.pause()`，关闭时无需恢复 |

播放细则：面板内全部用独立 `<audio>`（`audioUrl` 支持 Range），与主 wavesurfer 互不干扰；面板打开时 `ws.pause()`；每行 clip 播放时其他 clip 行暂停（单共同 `<audio>` 元素也行，实现二选一）。

---

## 7. 部署与构建

`server/docker/Dockerfile`：

- worker 层 torch 安装行改 `ARG TORCH_VARIANT=cpu` 版本（见 2.5）；
- 新增 `FROM worker AS verify`：`RUN pip install --no-cache-dir modelscope`（若最终采用 3D-Speaker vendor 方案则改为复制该模块并删掉此层）；`EXPOSE 8001`；`CMD ["uvicorn", "app.verify.server:app", "--host", "0.0.0.0", "--port", "8001"]`。

`docker-compose.yml`：

```yaml
verify:
  build: { context: ., dockerfile: server/docker/Dockerfile, target: verify }
  environment:
    DATABASE_URL: postgresql+psycopg://adg:adg@db:5432/adg
    DATA_DIR: /data
    MODELS_DIR: /models
    EMBEDDING_DEVICE: auto
    TORCH_NUM_THREADS: 10
  volumes:
    - appdata:/data:ro        # 只读：只取 audio.wav
    - models:/models:ro
  depends_on: { db: { condition: service_healthy } }
  restart: unless-stopped
```

`server/app/config.py`：`verify_url`、`embedding_device` 两个新设置（默认值如上，注释说明 GPU 配置）。`api` 服务加 `VERIFY_URL` 环境变量。

新增 `docker-compose.gpu.yml`（或 README 给出两行 `--build-arg` + override），供有 GPU 的部署机一键启用。`seed-models` 的下载脚本扩展后，模型下载同一条命令完成（`--profile setup run --rm seed-models`）。

---

## 8. 测试计划

沿用项目"纯函数全测、UI 不拍快照"的文化：

**服务端（`server/tests`，test 镜像无 torch，verify 模块延迟导入即可全测）：**

- `verify/service.py`：注入假 `embed`（恒等/已知向量）——缓存命中/缺失补写、model_id 变更即重算、重叠共享行、`max(0,cos)*100`、`short` 标记、无稳定音频说话人进 unranked。
- `domain.py`：重叠段 RTTM 往返（serialize → parse 等值）；`is_stable` 字段无感穿过 save/load。
- `routers/annotations.py`：`/similarity` —— 鉴权头、非法时间 422、verify 挂掉 503（httpx `MockTransport`）、正常响应透传。
- `verify/server.py`：端点契约（pytest + TestClient，stub 掉 `get_engine`）。

**前端（`ADG`，npm test）：**

- `reassignToSpeakers`：N=1 等价旧行为；N=2 含/不含原说话人；undo 恢复；时间范围等于原段；id 唯一性。
- `toggleStable` + 快照 undo。
- 面板：drawer 渲染 + 未勾选禁点（jsdom 断言）。

**端到端手测兜底（README 的 interact.mjs 脚本可扩展）：** 起 verify → 标记稳定 → 右键 → 出面板 → 试听 → 勾选两人 → 确认 → 时间轴出现两条同时间段、不同 lane 的块 → 导出 RTTM 出现两行同时间不同 speaker → 用 md-eval/dscore 抽查。

---

## 9. 实施顺序

1. DB + ORM + domain/schemas 字段（`is_stable`、`segment_embeddings`）——最小可合并。
2. verify 包：engine（真实推理，代码逻辑 stub 测）+ service 缓存/评分纯逻辑 + server.py。
3. API `/similarity` 端点 + `config.verify_url` + verify 不可用时的优雅错误。
4. 前端数据层（types/ops/reducer/client）+ Timeline 右键/徽标。
5. SimilarityPanel 组件 + `i` 快捷键 + 强制 save 流程。
6. Dockerfile `verify` stage + compose 服务 + GPU 参数；`download_models.py` 扩展 + 本机实测下载。
7. 测试补齐 + README（流程 + 许可 + GPU 说明）更新。

7 与 1-6 可并行（7 不阻塞代码），但按序验收。

---

## 10. 风险与回退

| 风险 | 应对 |
|---|---|
| modelscope sv 管线对"纯本地目录 + 离线加载"不友好（版本/API 波动） | **已冒烟实测通过（2026-08-29，`scripts/smoke_eres2net.py`）**：modelscope 1.39.1 `pipeline("speaker-verification", model=<本地目录>)` 离线可用；embedding API = `pipe.model.forward(<float32 波形 [T]>)` → 192 维（内部 Kaldi.fbank 80 维 + mean-subtract + ERes2Net_aug；**输入必须 float32**，soundfile 默认 float64 报 dtype 错）；同话移 0.5s cos≈0.94 vs 异窗口 cos≈0.48。权重文件名 `pretrained_eres2net_aug.ckpt`（221 MB，3D-Speaker 风格，**非 pytorch_model.bin**）。补充依赖：addict / simplejson / datasets(+pyarrow)。vendor 方案不需要 |
| 首次点击 = 全量补齐稳定片段缓存（最多十几秒） | 预计算兜底 + 面板 loading 文案；实测最常见（2~3 条稳定）在 5s 内 |
| embedding 键控浮点相等：JS number ↔ Python float JSON 往返是 IEEE754 精确的，约束不变就相等 | save 时 clamp 不影响浮点值（clamp 只在越界时改）；若未来出现 float 边界怪癖，退化为时间范围 ±1ms 查询（key 不变） |
| verify 被误当"必须在线"：新端点依赖它 | 503 文案明确 + README 注明 `db+api` 部署模式不受影响（不识别也能标：只是没相似度面板） |
| GPU 镜像体积/构建时间（cu118 wheel ~800MB） | 按需 build（`docker compose build verify` + override），README 写清；默认 CPU 流程不变化 |

---

## 11. 实现后记（2026-08-29 当日）

设计落地时的事实更新与遗留问题，留档以免重查：

- **engine 定论**：modelscope 1.39.1 管线离线加载（`pipeline("speaker-verification", model=<本地目录>)`），
  embedding API = `pipe.model.forward(<float32 波形 [T]>)` → 192 维（见 §10 冒烟记录与 `scripts/smoke_eres2net.py`）。
- **modelscope 依赖坑**：≤1.39 的 PyPI 元数据**不声明运行时依赖**（缺 addict / simplejson / datasets，
  导入即崩）——Dockerfile verify 阶段显式钉装三者；`seed-models` target 改为 `verify`（SDK 下载需要）。
- **ModelScope 当日后端故障**（metadata 500 / 文件 404 / 超时，SDK 同蹶）：models 卷里的 eres2net 权重
  是从本机冒烟副本 `docker cp` 注入的；**MS 恢复后重跑 `docker compose --profile setup run --rm seed-models`
  即验证脚本路径**（下载脚本已改用 SDK，含断点续传语义）。
- **Git Bash 坑**：docker 命令里 `/models` 等容器侧路径会被 MSYS 转义 → `export MSYS_NO_PATHCONV=1`。
- **运行时验证**（本机 compose：db / api / verify / dbweb 全绿）：`scripts/e2e_similarity.py` 通过——
  相似度排名正确（真身 98.3% > 50% > 43%）、embedding 缓存命中（首次 730ms → 6ms）、
  重叠改判导出**两行同窗口不同 speaker** 的标准 RTTM。
- **音量增益**（超出原意图范围的交互补充）：页面保证“默认 100% 不经过 WebAudio”；
  用户主动调到 >100% 时才把主播放器与识别面板的媒体元素路由进共享 GainNode+限幅器（50%–500%），
  实现同视频站点的“超 100% 音量”（`ADG/src/audio/masterVolume.ts`）。
- **遗留（未关闭）**：用户在自有环境反馈“播放无声音”。已用 CDP 实测：应用链路（media 元素
  `play()`→ 推进 → `playUntil` 精确暂停）与音频端点（Range 206、`canplaythrough`）均正常；
  j 走查试听停在 2.4s 短段段尾属**设计行为**。仍需用户侧确认系统输出设备 / 音量合成器滑块后归因。
