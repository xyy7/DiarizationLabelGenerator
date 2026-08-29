# 任务列表：说话人稳定音频与声纹相似度改判

计划文档见 `tasks/plan.md`；设计见 `docs/spec/speaker-similarity.md`。

## Phase 0 — 冒烟
- [x] Task 1: eres2net 本机冒烟（✅ 192 维 embedding、同窗 0.94 vs 异窗 0.48；结论回写 spec §10）

## Phase 1 — 服务端
- [x] Task 2: 数据层（is_stable + segment_embeddings；save/load 贯通；重叠 RTTM 往返测试）
- [x] Task 3: verify 内核（engine + service 纯逻辑；engine 路径经冒烟定论）
- [x] Task 4: verify 服务（/similarity /precompute /healthz；契约测试）
- [x] Task 5: API /similarity 端点（+config.verify_url；422/503 测试）

## Phase 2 — 前端
- [x] Task 6: 前端数据层（types/operations/reducer/client + 单测）
- [x] Task 7: Timeline 右键菜单 + ★ 徽标 + `i` 快捷键
- [x] Task 8: SimilarityPanel（本段播放醒目、逐行试听、多选改判、强制 save、独立播放）

## Phase 3 — 构建部署与文档
- [x] Task 9: Dockerfile verify stage + TORCH_VARIANT + compose + gpu override（镜像 1.65GB 构建成功、容器运行中；modelscope 1.39 需显式装 addict/simplejson/datasets）
- [x] Task 10: download_models.py 扩展（SDK 路径；**ModelScope 当天后端故障**（500/404/超时），本机用冒烟副本直接 seed 进 models 卷；MS 恢复后重跑 seed-models 即复现）
- [x] Task 11: README + 端到端核对（scripts/e2e_similarity.py 全通过：相似度 98.3% 排名正确、缓存 730ms→6ms、重叠 RTTM 两行同窗口）；md-eval/dscore 抽查留给用户/后续

## 检查点
- [x] A（Task 1）：冒烟定论（modelscope 管线 + sv.model.forward），spec §10 已回写
- [x] B（Task 2–4）：服务端 119 passed（全量，含 verify 契约测试）
- [x] C（Task 5）：API 契约测试全绿（422/503/透传/precompute 兜底）
- [x] D（Task 6–8）：前端 58 passed + tsc 零错误 + vite build；功能 E2E API 层通过（98.3% 排名、缓存 6ms、重叠 RTTM）；浏览器交互经 CDP 验证
- [x] E（Task 9–11）：verify 容器构建(1.65GB)并运行于本机，seed 路径待 ModelScope 恢复后复验（见 spec §11）；遗留品：用户侧“无声音”待归因（见 HANDOFF 第八节）
