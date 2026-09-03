   # DiarizationLabelGenerator

说话人分离（speaker diarization）标注工具，**客户端–服务端的纠错式标注系统**。
服务端跑 DiariZen 出预标注、并持有音频 / 标注 / 任务状态；浏览器只是视图。

工作流程：上传音频 → DiariZen 预标注（或导入外部 RTTM）→ 标注员逐段纠错 →
标记完成 → 导出**标准 10 字段 RTTM**（可直接喂 `md-eval.pl` / `dscore` 算 DER）。

```bash
docker compose up -d db api     # 起服务；前端由 api 直接托管
# 浏览器打开 http://localhost:8000
```

## 目录

| 目录 | 内容 |
|---|---|
| `server/` | FastAPI + Postgres：音频归档、预标注任务队列（worker）、标注存取、RTTM 导出；`app/verify/` 为说话人相似度服务 |
| `ADG/` | 前端标注应用（Vite + React + TS）：列表认领 + 快捷键为主的纠错交互 |
| `docker-compose.yml` | db / api / worker / verify / seed-models / test（GPU 见 `docker-compose.gpu.yml`） |
| `docs/` | 意图书（`intent/`）、技术方案（`spec/`）、交接文档（`HANDOFF.md`），**入 git** |
| `diarizen-config/` | DiariZen 纯 CPU 环境配置与推理脚本，以及权重下载脚本（worker/verify 镜像用） |
| `tasks/` | 任务记录（按 `YYYY-MM-DD/` 分文件夹），**不入 git**（`.gitignore`） |
| `tests/` | 手工测试样例数据（客户音频、中间产物），**不入 git**（`.gitignore`）；自动化测试套件在 `server/tests/`（入 git） |

`ADG/` 已并入本仓库：前端与 server 同一 git 仓库演进（此前 `ADG/` 是独立 git
仓库，其 13 个提交经前缀重放合并保留，原始哈希备份在 `backups/adg-history-20260830.bundle`；
`git log -- ADG/` 可正常追溯，详见 `docs/HANDOFF.md` 第五节）。
`DiariZen/` 为上游仓库：体积大、有独立 git 历史，**不纳入本仓库**（仅 worker
镜像构建时复制进去，由 `diarizen-config/setup.ps1` 负责拉取）。

## 标注流程

1. **上传音频**。首页「上传音频」，自动归一化为 16 kHz 单声道。
2. **预标注**。**不自动跑**——上传后停在「待预标注」，两条用户触发的路径：
   - 点击列表页「**预标注**」按钮 → worker 认领跑 DiariZen（见下）；
   - 或本地跑出 RTTM 后点击「导入 RTTM」。
3. **认领并标注**。**任何状态都能认领**（预标注只是可选项）：
   已预标注的会带着 DiariZen 片段进入标注页；未预标注的从空白开始标。
   点击「认领并标注」进入标注页：`J`/`K` 逐段走查试听，
   改判（`1`–`9`）、拆分（`S`）、合并（`M`）、微调边界（`,`/`.`）、
   新建说话人（`N`）。自动保存（2 秒防抖）。
   （认领一个正在预标注的文件会自动取消该预标注任务，人工优先。）
   工具栏「音量 %」按钮可调 **50%–500%**（超过 100% 为数字增益 + 限幅，
   同视频站点做法；默认 100% 走原生路径，不经过 WebAudio）。
4. **声音识别辅助（可选，需 verify 容器）**。右键片段 →「设为稳定音频」
   （该说话人的参考声纹，建议 2~5 段且 ≥2s）；对拿不准的片段点右键 →
   「自动识别相似度…」（或选中后按 `I`），面板按 eres2net 相似度列出各
   说话人，每段稳定音频可以试听对照，勾选后一键改判；**勾多个说话人 =
   这段同时属于多人（重叠标注）**，导出 RTTM 以多层重叠正确表达。
5. **标记完成并导出**。标注页「标记完成」；列表页按文件导出 RTTM，
   或「导出全部已完成（zip）」。

## 自动预标注（worker）

worker 镜像含 torch（约 186 MB，本机实测该线路很慢），构建一次即可：

```bash
docker compose build worker
docker compose --profile setup run --rm seed-models   # 下载权重（HuggingFace 需代理）
docker compose up -d worker
```

未构建 worker 时用第 2 步的「导入 RTTM」路径即可，不影响主流程
（本地跑 DiariZen 见 `diarizen-config/SETUP_CPU.md`）。

**内存**：DiariZen 默认 batch_size=32（GPU 调优值），CPU 推理峰值 ~6.6GB，
8GB 机器会被 Linux OOM 杀成「无限重试」。worker 已内置 batch=4（峰值 ~2.6GB），
代价是 CPU 上更慢（约 2 倍实时）；内存 ≥16G 或上 GPU 时可改回 32
（`server/app/worker/diarize.py` 的 `config_parse`）。

## 声音识别（verify，可选）

相似度功能需要一个额外的 verify 容器（eres2net，模型来自魔搭社区）：

```bash
docker compose build verify
docker compose --profile setup run --rm seed-models   # 一并下载 eres2net 权重（~221 MB，modelscope.cn 直连）
docker compose up -d verify
```

未起 verify 时自动识别不可用（面板会提示），**其它一切功能照常**；
`db + api` 的最小部署模式不受影响。

**GPU**：verify 会在有 CUDA 设备时自动使用（`EMBEDDING_DEVICE=auto`）。
容器需要 CUDA 版 torch，且要构建并起用 GPU 覆盖文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml build verify
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d verify
```

无 GPU 机器始终走 CPU（实测约 0.4× 实时，单次右键识别 1~3 秒级）。

## 远程 GPU 部署（AutoDL）

没有 docker 的 GPU 机器（AutoDL 容器）用裸机方式部署同一套服务：
镜像自带 torch 走 CUDA、权重走 hf-mirror/ModelScope 快速下载、批大小自动跟随
GPU、端口 6006 对外。详见 `docs/deploy-autodl.md`。

## 测试与验证

```bash
docker compose --profile test run --rm test pytest -q     # 服务端
cd ADG && npm test                                        # 前端
cd ADG && node scripts/interact.mjs http://localhost:8000 <recordingId>   # 浏览器核对
```

浏览器核对脚本会用本机 Chrome 逐个验证快捷键、持久化，并把时间轴渲染成字符画。

## 备份

```bash
sh server/scripts/backup.sh   # 数据库 + 音频卷 → ./backups/
```

人工标注是这项目里最贵的数据，务必定期备份（建议另存异机/NAS）。细节见脚本注释。

## 许可

- `ADG/` 与 `server/` 为本项目自有代码。
- DiariZen 代码为 MIT，但其**预训练权重是 CC BY-NC 4.0，仅限研究与学术用途，不可商用**。
  若本工具需要商用，必须替换权重或另行取得授权。
- eres2net 说话人识别模型（`iic/speech_eres2net_sv_zh-cn_16k-common`，魔搭社区）
  同为 **CC BY-NC 4.0**，仅限研究与学术用途。
