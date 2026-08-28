# 交接：2026-08-29

本次会话把 ADG 从「纯前端手工标注工具」改造成**客户端–服务端的纠错式标注系统**。
意图书见 [`intent/adg-refactor.md`](intent/adg-refactor.md)，本文记录**做了什么、验证到什么程度、还欠什么**。

---

## 一、当前可用性

**能跑通完整流程**，但没到可以交给团队的程度。缺口见第四节。

```
上传音频 → 本地 conda 跑 DiariZen → 导入 .rttm → 界面纠错 → 导出标准 RTTM
```

服务在 `http://localhost:8000`（`docker compose up -d db api`）。

---

## 二、做了什么

### 新建 `server/`（FastAPI + Postgres）

| 模块 | 职责 |
|---|---|
| `app/rttm.py` | **全系统唯一**的 RTTM 序列化/解析。严格 10 字段、`chnl` 恒为 1、`ortho` 恒为 `<NA>` |
| `app/domain.py` | 纯规则：边界钳制、说话人校验、RTTM ↔ 标注映射。无数据库依赖，可裸跑 pytest |
| `app/annotations.py` | `save_annotation()`——用户保存与预标注写入**共用的唯一写路径** |
| `app/ingest.py` | 流式哈希去重 → 探测 → 归一化 16k mono wav → peaks → 入库 |
| `app/audio.py` | PyAV 解码/重采样、HTTP Range 响应（206/后缀/416） |
| `app/peaks.py` | 波形包络，**100 点/秒**（10ms 一格） |
| `app/worker/` | `jobs.py` 认领与僵尸恢复、`diarize.py` DiariZen 封装、`worker.py` 常驻循环 |
| `app/routers/` | recordings / annotations / export |

### 重写前端 `ADG/src/`

删除：`App.tsx`、`store/`、`utils/`、`types/`、`components/{AudioPlayer,ChannelPanel,Timeline}/`、
`improvements.md`、`test_data/sample_labels.json`（**均在 ADG git 历史中可取回**）。

新增：`pages/{Workbench,Annotator}`、`components/{Timeline,Waveform,ShortcutHelp}`、
`annotation/{operations,reducer}`（纯逻辑 + 撤销栈）、`api/client.ts`、`scripts/*.mjs`（浏览器验证）。

### 基础设施

`docker-compose.yml`（db / api / worker / seed-models / test）、多阶段 `Dockerfile`、
`server/scripts/backup.sh`、`.dockerignore`、`.mcp.json`。

---

## 三、验证到什么程度

```
服务端   96 passed    docker compose --profile test run --rm test pytest -q
前端     43 passed    cd ADG && npm test
类型     tsc --noEmit 干净
浏览器   node ADG/scripts/interact.mjs http://localhost:8000 <recordingId>
```

浏览器验证用 `playwright-core` + 本机已装 Chrome（不下载 Chromium）：

- `uicheck.mjs` —— 对齐、缩放、播放、选中、改判
- `audit.mjs` —— 零警告标准、可访问性树、LCP/CLS/长任务、多视口
- `interact.mjs` —— 逐个快捷键 + 持久化 + **把时间轴渲染成字符画**（替代看图）
- `shot.mjs` —— 截图（按扩展名决定格式）

实测数据：波形与 4 条轨道 `dx=0 dw=0`，缩放到 4050px 仍然 `dx=0 dw=0`；
检出 8 对跨说话人重叠；LCP 628ms、CLS 0、无横向溢出。

**未验证**：真实 20 分钟会议音频（只测过 30 秒与合成 2 秒）、多人并发标注、
失败任务的界面呈现、**以及全部观感**（当前模型读不了图，见全局 `CLAUDE.md`）。

---

## 四、待办（按是否挡住干活排序）

### P0 — 会挡住实际标注

- [x] **新增/拆分说话人**（2026-08-29 完成）。说话人面板加「＋ 新建说话人」按钮 + 快捷键 `N`：
      有选中片段 → `SPLIT_SPEAKER` 把这段拆给新说话人（VBx 两人并一个标签的首选修复）；
      未选中 → 新增 `CREATE_SPEAKER` 建空说话人（漏人时画片段/数字键改判用）。
      新标签取第一个空闲整数，跳过合并后留下的稀疏 label（保证 DiariZen 重跑可比）。
      帮助面板与常驻快捷条已同步（ShortcutHelp `GROUPS` 是唯一事实来源）。
      前端测试 43 → **47**，`interact.mjs` 新增 N 键断言，全绿。

### P1 — 会误导人

- [x] **三份文档已更新**（2026-08-29）：
      `README.md`（客户端–服务端流程、容器化、备份）、
      `ADG/ARCHITECTURE.md`（重写：类型即服务端镜像、编辑缓冲 + 快照式撤销、共享时间轴）、
      `ADG/USER_GUIDE.md`（重写：纠错工作流、含 `N` 的完整快捷键表；旧 v0.1.0 说明整段作废）。
- [ ] 仓库结构待定：根目录与 `ADG/` 是两个独立 git 仓库（见第五节）

### P2 — 数据安全

- [x] **备份首次运行成功**（2026-08-29）。运行中**发现并修复了脚本两个隐蔽缺陷**，
      **备份跑通 ≠ 备份可恢复**——首轮产出的 data 包实际是空卷（87 字节）：
      1. MSYS2 把 Docker `-v` 参数里的容器侧 `/backup` 改写成了 Git 安装根目录
         `D:/05-git/Git/backup`（`-v` 的每一段 POSIX 路径都会被转换）→ tar 打不开目标文件。
         修法：Git Bash 下用 `pwd -W` 取 Windows 目录 + `MSYS_NO_PATHCONV=1`。
      2. `compose config --format json` 的 `source` 是**符号名** `appdata`（带空格，原 sed 也不匹配），
         回退路径 `tr -cd '[:alnum:]'` 又剥掉了项目名里的连字符——恰好命中旧版 compose 留下的
         **空卷** `tool03audiolabelgenerate_appdata`。
         修法：从运行中 api 容器的 mount 取真名（`docker inspect --format '{{range .Mounts}}...'`），
         回退才用项目名约定。
      核验：`pg_restore -l` 列出 33 个 TOC 条目；tar 内含 `audio/`、`exports/`。
      `backups/` 里旧空包 `data-20260829-020350.tar.gz` 已删，保留三个 db dump。
- [ ] 第二阶段动 schema 前必须先引入 Alembic（届时库里已有昂贵的人工标注，不能靠重建）

### P3 — 已知取舍，不急

- [ ] **worker 镜像未构建、模型卷为空**（`4.0K`）。自动预标注不可用，
      当前靠本地 conda + 导入接口替代。构建需下载 186MB torch（实测该线路约 180 KB/s，
      约 17 分钟），超出单条命令时限，**需在你自己的终端跑**：`docker compose build worker`，
      然后 `docker compose --profile setup run --rm seed-models`（HuggingFace 需代理，
      容器内用 `host.docker.internal:7890`）
- [ ] 字幕（第二阶段）。`segments.text` 字段已留，SRT 导入导出已移出 UI，可从 git 历史取回
- [ ] 一个 104ms 长任务（首屏渲染），1MB 打包体积未做分包

---

## 五、需要你决定的事

**仓库结构。** 根目录与 `ADG/` 是**两个独立 git 仓库**（根仓库含 server/，`ADG/` 独立且有多个历史提交）。
本次已分别提交，但长期需要一个决定：

- 保持两个仓库（现状，`ADG/` 在根仓库的 `.gitignore` 里）
- 用 `git subtree` 把 ADG 并入根仓库（保留历史）
- 删除 `ADG/.git` 合并（**会毁掉历史，届时我说过的「删掉的旧文件可从 git 取回」将不成立**）

`DiariZen/` 按原 README 的约定不纳入版本控制（上游代码、体积大、有独立历史）。

---

## 六、过程中发现并修复的缺陷

留档以免重复踩。

### 原有代码的（本次重构的起因）

| 缺陷 | 位置 | 后果 |
|---|---|---|
| RTTM 第 3 字段填成说话人序号（应恒为 `1`） | 原 `utils/label.ts:40` | **DER 算不出**，除首个说话人外全判 miss |
| text 挤成第 11 字段（标准 10 字段） | 同上 | 严格解析器报错 |
| 监听 `seek`，v7 事件名是 `seeking` | 原 `AudioPlayer/index.tsx:130` | 暂停时点击波形播放头不动（被 `@ts-ignore` 掩盖） |
| `channels` 挂在 Project 上不跟随音频 | 原 `types/index.ts` | 多文件标注不可行 |
| 导入标签时 `items` 被静默丢弃 | 原 `App.tsx:133-137` | 只建出空通道 |

### 本次新写代码里被测试抓到的

| 缺陷 | 根因 |
|---|---|
| 失败任务永远卡在 `running` | 原生 SQL 更新后 ORM 身份映射陈旧，`mark_failed` 认为 status 未变而不发出该字段的 UPDATE。修法：`db.get(..., populate_existing=True)` |
| 重试配额永远用不完 | `attempts` 只在「原状态 running」的认领分支自增，重新入队走 `queued` 分支。统一为「attempts = 未成功的运行次数」 |
| 标注页整页崩溃 | `ws.zoom()` 在音频加载完成前抛 `No audio loaded` |
| **Tab 焦点陷阱** | 把 Tab 绑成「下一段」，键盘用户无法走到任何控件。改用 `J`/`K` + 方向键，Tab 归还浏览器 |
| 说话人输入框无可访问名称 | 缺 `aria-label` |
| `RecordingOut.claimed_by` 与 ORM 外键同名 | `from_attributes` 拿 UUID 去按嵌套对象校验，claim 接口 500 |

### 环境层面的坑

- **DiariZen 的 RTTM 会超出音频长度**（自带样例超 0.393s）。入库钳制并**明确上报**，禁止静默截断
- **golden 文件是 CRLF**（Windows 上 Python 文本模式写的），Linux 容器里是 LF。fixture 存 LF，解析器容忍两者
- **wavesurfer v7 渲染进 shadow DOM**，`document.querySelector('canvas')` 找不到——是探测方式的问题
- **antd 会把「保存」渲染成「保 存」**（CJK 自动插空格），已用 `autoInsertSpace: false` 关闭
- **`docker build | tail` 会掩盖退出码**（管道退出码来自 `tail`），我曾因此误报过一次构建成功
- Debian `ffmpeg` 包拖进 150+ 依赖且该线路频繁断连 → 改用 PyAV（wheel 自带 FFmpeg 库），**镜像零系统包**

---

## 七、常用命令

```bash
# 起服务
docker compose up -d db api

# 测试
docker compose --profile test run --rm test pytest -q     # 服务端 96
cd ADG && npm test                                         # 前端 43

# 浏览器验证（需先 npm run build 并 docker compose build api）
cd ADG && node scripts/interact.mjs http://localhost:8000 <recordingId>

# 备份（尚未验证）
sh server/scripts/backup.sh

# worker（需在自己的终端跑，约半小时）
docker compose build worker
docker compose --profile setup run --rm seed-models
docker compose up -d worker
```
