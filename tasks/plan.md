# Implementation Plan: 说话人稳定音频与声纹相似度改判

## Overview

在现有客户端–服务端标注系统上实现：单文件内为各说话人标记「稳定音频」，右键任意片段 →「自动识别」→ 侧边面板按 eres2net 相似度排序（每段稳定音频可试听 + 百分比），勾选 1~N 个说话人确认后改判；勾多个 = 重叠讲话（同时间多段）。新增 `verify` 容器跑模型，embedding 按音频内容缓存进 Postgres。

上游：意图 `docs/intent/speaker-similarity.md`；方案 `docs/spec/speaker-similarity.md`（本节不再重复决策依据）。

## Architecture Decisions（详见 spec）

1. 重叠 = 两段同时间不同说话人（既有表达，RTTM 导出天然正确）
2. eres2net 部署为 `verify` 容器（`FROM worker AS verify`），API 零 torch
3. 评分 = `max(0,cos)×100`；说话人行取最高片段分；无稳定音频者底部灰置
4. embedding 缓存按内容键控（recording_id+起止时间+model_id），时间变/模型变自动失效；改判不失效
5. GPU = `TORCH_VARIANT=cpu|cu118`（构建）+ `EMBEDDING_DEVICE=auto`（运行）
6. 面板改判走前端本地纯函数操作 → 既有 undo/自动保存管线

## Task List

### Phase 0 — 冒烟（fail fast）
- [ ] **Task 1: eres2net 本机冒烟** —— 下载官方 checkpoint + 验证离线加载产出 192 维 embedding（同人 cos > 异人）；定论 engine 实现路径（modelscope 管线 vs vendor 3D-Speaker），结论写回 spec §10。脚本 `scripts/smoke_eres2net.py`（临时）。

### Phase 1 — 服务端数据与识别内核
- [ ] Task 2: 数据层 —— `segments.is_stable` + `segment_embeddings` 表（schema.sql/models/domain/schemas 同步），save/load 贯通，含重叠 RTTM 往返与 is_stable 往返测试
- [ ] Task 3: verify 内核 —— `verify/engine.py`（按 Task 1 定论）+ `verify/service.py`（缓存/归一化/余弦/排名纯逻辑，stub embed 可测）
- [ ] Task 4: verify 服务 —— `verify/server.py`（/similarity /precompute /healthz，lifespan warmup，TestClient 契约测试）
- [ ] Task 5: API 端点 —— `POST /api/recordings/{id}/similarity` + `config.verify_url` + VerifyClient（MockTransport 测 422/503/透传）

### Checkpoint A（Task 1）
- [ ] 冒烟结论落定（管线 or vendor），spec §10 更新
- [ ] 每一步有真实 16k wav、192 维 embedding、同人>异人
- [ ] 与用户对齐后进入 Phase 1

### Checkpoint B（Task 2–4）
- [ ] `docker compose --profile test run --rm test` 全绿
- [ ] verify 单测（stub embed）全绿
- [ ] 服务端数据+内核可独立交付

### Checkpoint C（Task 5）
- [ ] API 契约测试全绿；verify 未启动时 503 文案正确

### Phase 2 — 前端
- [ ] Task 6: 前端数据层 —— types（is_stable/SimilarityResult）+ operations（`reassignToSpeakers`/`toggleStable`）+ reducer（TOGGLE_STABLE/REASSIGN_MULTI）+ client（`similarity()`）+ 单测（N=1 等价旧行为、N≥2 含/不含原说话人、undo、id 唯一）
- [ ] Task 7: Timeline 右键 —— segment `onContextMenu` 菜单（自动识别/稳定音频开关/删除）+ ★ 徽标 + Annotator 挂载 + `i` 快捷键
- [ ] Task 8: SimilarityPanel —— antd Drawer；**头部「▶ 播放本段」醒目**；行 = 说话人 + best% + 展开稳定片段（各带 ▶ + %）；按说话人勾选（多选=重叠）；确认改判回调；打开前 dirty 强制 save；面板内独立 `<audio>` 互斥播放、打开时暂停主播放器、503/加载态文案

### Checkpoint D（Task 6–8）
- [ ] `cd ADG && npm test` 全绿；`npm run build` 通过
- [ ] 本机 compose（db+api+verify）手测：标记稳定 → 右键 → 面板试听对照 → 勾两人改判 → 时间轴两条同时间块 → RTTM 两层重叠
- [ ] 功能评审通过后进入 Phase 3

### Phase 3 — 构建部署与文档
- [ ] Task 9: 镜像与编排 —— Dockerfile `ARG TORCH_VARIANT` + `FROM worker AS verify`（含 modelscope 或 vendor 依赖）+ compose `verify` 服务（appdata 只读、models 只读、EMBEDDING_DEVICE）+ `docker-compose.gpu.yml`
- [ ] Task 10: 模型下载 —— `download_models.py` 扩展 ModelScope 条目（requests 流式+断点），走 seed-models 实测打通（直连/代理行为核验）
- [ ] Task 11: 收尾 —— README（流程、CC BY-NC 许可补充、GPU 双路径说明、`db+api` 部署模式提示）；端到端核对脚本（interact.mjs 或手点）+ 导出 RTTM 交给 md-eval/dscore 抽查

### Checkpoint E（Task 9–11）
- [ ] 干净机器按 README 三步走：build verify → seed-models → up verify；GPU override 文件可用
- [ ] 全量自动化测试绿（服务端 + 前端）
- [ ] 交付评审：用户确认

## Risks and Mitigations

| 风险 | 影响 | 应对 |
|---|---|---|
| modelscope 管线离线加载/embedding 提取不便 | 高 | Task 1 先冒烟定论；备选 vendor 3D-Speaker（MIT）不影响其余设计 |
| modelscope.cn 直连在部署机不可用（代理规则） | 中 | Task 10 核验；下载脚本保留代理环境变量通道；失败则走 hf-mirror 镜像（该模型有镜像时） |
| 首次点击补齐缓存 >5s | 中 | 保存后预计算兜底 + 面板 loading 文案；实测校准 |
| GPU 镜像体积/构建慢（cu118 ~800MB） | 低 | 按需构建，README 写明；CPU 默认路径不受影响 |

## Open Questions

- [ ] 无阻塞问题。面板播放器「单一共享 `<audio>`」vs「每行一个元素」实现二选一，Task 8 内自决。
