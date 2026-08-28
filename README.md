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
| `server/` | FastAPI + Postgres：音频归档、预标注任务队列（worker）、标注存取、RTTM 导出 |
| `ADG/` | 前端标注应用（Vite + React + TS）：列表认领 + 快捷键为主的纠错交互 |
| `docker-compose.yml` | db / api / worker / seed-models / test |
| `docs/` | 意图书（`intent/adg-refactor.md`）、交接文档（`HANDOFF.md`） |
| `diarizen-config/` | DiariZen 纯 CPU 环境配置与推理脚本，以及权重下载脚本（worker 镜像用） |

`DiariZen/` 为上游仓库：体积大、有独立 git 历史，**不纳入本仓库**（仅 worker
镜像构建时复制进去）。

## 标注流程

1. **上传音频**。首页「上传音频」，自动归一化为 16 kHz 单声道。
2. **预标注**。两条路径：
   - worker 构建完成后自动跑 DiariZen（见下）；
   - 或本地跑出 RTTM 后在列表页「导入 RTTM」。
3. **认领并标注**。点击「认领并标注」进入标注页：`J`/`K` 逐段走查试听，
   改判（`1`–`9`）、拆分（`S`）、合并（`M`）、微调边界（`,`/`.`）、
   新建说话人（`N`）。自动保存（2 秒防抖）。
4. **标记完成并导出**。标注页「标记完成」；列表页按文件导出 RTTM，
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
