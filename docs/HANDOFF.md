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
- [x] 仓库结构：根目录与 `ADG/` 曾是**两个独立 git 仓库**——2026-08-30 已统一为单仓库
      （`ADG/` subtree 并入保留历史，见第五节）

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
- [x] **第二阶段动 schema 前必须先引入 Alembic**（2026-09-05 完成，见九期）——届时库里已有昂贵的人工标注，不能靠重建

### P3 — 已知取舍，不急

- [ ] **worker 镜像未构建、模型卷为空**（`4.0K`）。自动预标注不可用，
      当前靠本地 conda + 导入接口替代。构建需下载 186MB torch（实测该线路约 180 KB/s，
      约 17 分钟），超出单条命令时限，**需在你自己的终端跑**：`docker compose build worker`，
      然后 `docker compose --profile setup run --rm seed-models`（HuggingFace 需代理，
      容器内用 `host.docker.internal:7890`）
- [ ] 字幕（第二阶段）。`segments.text` 字段已留，SRT 导入导出已移出 UI，可从 git 历史取回
- [ ] 一个 104ms 长任务（首屏渲染），1MB 打包体积未做分包

---

## 五、已决定的仓库结构（2026-08-30 执行）

根目录与 `ADG/` 曾是**两个独立 git 仓库**（根仓库含 server/，`ADG/` 独立且有多个历史提交）。
**已统一为单仓库**：

- `ADG/` 已并入根仓库。前端历史（13 个提交）在临时克隆上以 `ADG/` 前缀重写后合并
  （filter-branch 重放：内容/提交信息/作者/日期原样，哈希为重写版；原始哈希的完整备份在
  `backups/adg-history-20260830.bundle`，`git bundle verify` 通过）。
  `git log -- ADG/`、`git log --follow -- ADG/src/……` 均可正常追溯。
- `DiariZen/` **不纳入版本控制**（上游代码、体积大、有独立历史），
  由 `diarizen-config/setup.ps1` 自动 clone，见 `.gitignore`。

后续再次改动 ADG 时，直接在本仓库内提交即可，无需特殊命令。

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
| 快捷键 ⇧ 大跳（100ms）从不生效 | `e.key` 在 Shift 组合下是 `<`/`>`（非 `,`/`.`），switch 只写基础键，`e.shiftKey` 分支从未执行；用户实测发现，见第八节六期 |

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

---

## 八、二期：说话人相似度识别（2026-08-29 同期）

完整链路：意图 [`intent/speaker-similarity.md`](intent/speaker-similarity.md) →
方案 [`spec/speaker-similarity.md`](spec/speaker-similarity.md) →
任务记录 `tasks/2026-08-29/`（本地文件，与 tests/ 一样**不入 git**，见 `.gitignore`）。
**已实现、已部署本机、E2E 通过**。

### 做了什么

- **数据层**：`segments.is_stable`（稳定音频标志，不入 RTTM）+ `segment_embeddings`
  缓存表（按音频内容键控，改判不失效、重叠共享）。
- **新 `verify` 容器**（`FROM worker AS verify`，:8001）：eres2net（modelscope
  离线加载，55M/192 维，CPU 实测 0.4× 实时）；`app/verify/{engine,service,server}.py`；
  GPU 为构建参数 `TORCH_VARIANT` + 运行 `EMBEDDING_DEVICE=auto`（`docker-compose.gpu.yml`）。
- **API**：`POST /api/recordings/{id}/similarity`（时间窗口定位，422/503 规范）；
  标注保存后 fire-and-forget 预计算缓存。
- **前端**：片段右键菜单（自动识别/设为稳定/删除）、★ 稳定徽标、`I` 快捷键、
  `SimilarityPanel`（本段与逐候选试听、多选=重叠改判、走 undo/自动保存）；
  工具栏**音量增益 50%–500%**（默认 100% 原生路径；>100% 才接 WebAudio 增益链）。
- **配置**：`server/app/config.py`（verify_url / embedding_device）、
  `download_models.py`（SDK 拉取 eres2net）、README / 帮助面板同步。

### 验证到什么程度

```
服务端   126 passed   docker compose --profile test run --rm test pytest -q
前端     59 passed    cd ADG && npm test；tsc 零错误；vite build 通过
端到端   python scripts/e2e_similarity.py —— 相似度 98.3% 排名正确、
        缓存命中（首次计算后即毫秒级）、重叠双行 RTTM ✓；verify /healthz 在线
手动     CDP 实测：短段(J 走查)停在段尾属设计行为；播放链路事件正常
```

### 三期：修复轮（2026-08-31）

一次全仓扫描修复后计数：服务端 **126**（119 + 7 个新回归测试：rttm nan/inf/零时长四项、
domain nan/亚毫秒两项、verify 缓存容差一项），前端 **59**（新增"改判为同说话人无变化"用例）。
服务端测试用 `--build` 重建 test 镜像后容器内全量；直接宿主 pytest 为 58 passed（verify 系 5 项需容器）。

### 四期：worker 预标注部署与预标注流程调整（2026-09-04）

一期遗留的「worker 镜像未构建」在本期闭环，并借机把预标注改成**用户手动触发**：

- **worker 镜像从零构建**后连续暴露三个 DiariZen 缺失依赖并全部补齐：
  `toml`（pipelines/inference.py）、`psutil`（utils.py，被 pyannote.audio.core.model
  链式 import）、`accelerate`（utils.py 模块级）。三者 DiariZen pyproject 均未声明
  （README 靠 `pip install -r requirements.txt` 绕过，而镜像只装 `pip install -e .`）。
  Dockerfile 补丁已加注释说明为何 verify 之前没暴露这些缺失。
- **OOM 根因与修复**：预标注反复失败实测为 Linux OOM killer 杀进程——
  模型默认 `batch_size=32`（GPU 调优值），CPU 推理峰值 ~6.6GB，8GB 机器扛不住
  （dmesg 三连确认）。`diarize.py` 用 `config_parse` 降到 batch=4，峰值 ~2.6GB；
  note：config_parse 是**整段替换**，inference/clustering 两个 section 全部键值
  须逐字复制，否则 seg_duration/segmentation_step/Fa/Fb 静默消失。
- **预标注改手动**：列表页 uploaded 状态加「预标注」按钮（POST /diarize）。
  批注：上传端点从不自动入队——一期的 `status="uploaded"` 就是等待用户，
  此前"自动预标注"从未存在过。
- **认领放宽**：`CLAIMABLE` 从 {ready, annotating, done} 扩到全部状态——
  预标注为可选项。认领 running/queued 的录音时自动把对应 job 置为
  failed("cancelled: claimed by annotator")，防 worker 干完覆盖人工标注
  （原 VersionConflict 兜底保留，此处为第二道防线）。
- 验证：1 分钟音频预标注 **2 分钟完成**（queued→succeeded，10 段/3 说话人）；
  服务端 126 passed、前端 59 passed、tsc 零错误、vite build 通过；
  claim 接口实测 ready→annotating，归认领人。

### 五期：播放红线冻结修复（2026-09-05）

用户报「播放→暂停→重启后红线不动但声音在播」。定位与修复：

- **根因在标注器的红线时钟**：Timeline 的红色播放头由 `currentTime` state 驱动，
  而该 state 只订阅 wavesurfer 的 `audioprocess` 事件。wavesurfer v7 中
  `audioprocess` 由 16ms 定时器发出，且**被内部 `isSeeking` 信号门控**
  （dist/wavesurfer.js `initTimerEvents`：`if (!this.isSeeking())`）。一旦某次
  seek（最典型：点击波形跳转，远程/慢速音频端点下字节范围响应超时，或 seek 被后
  来的 seek 覆盖）的 `seeked` 事件不达，门控信号永远为 true——之后每次 tick 静默：
  媒体元素照常发声（时间推进），红线从此冻结，**任何空格/走查操作都无法恢复**，
  直到刷新页面。这正是「声音在播、红线不动」的形态。
- **修法（ADG/src/components/Waveform.tsx）**：除 `audioprocess` 外同时订阅
  `timeupdate`——媒体元素自身的 `timeupdate` 事件**不受 isSeeking 门控**
  （`initPlayerEvents`），走寻不到「流畅路径」时用媒体的真实时间驱动红线；
  重复事件对 `setCurrentTime` 幂等。另修正遗留注释「点波形会 seek 并播放」——
  v7 点击只 seek，不播放。
- 验证：tsc 零错误、前端 59 passed、vite build 通过；CDP 实测（headed Chrome + 真实
  60s 音频 + Range 服务 + boost 150%）play/暂停/重放/点波形/相似度面板往返后播放，
  红线均正常移动，无回归。复现脚本在 `tests/playhead/`（mock_server.py 支持
  `ADG_MOCK_FAULTY=1` 模拟远端 Range 卡死，本地 Chrome 对此仍会补发 seeked——
  卡死在真实网络条件才出现，故以机制分析 + 门控路径源码为准收口）。

### 六期：标注器快捷键——起点微调与 ⇧ 大跳修复（2026-09-05）

用户在测标注流程时发现「终点微调 ∓10ms（⇧ 为 100ms）」的 ⇧ 大跳**从未生效**，
并提议补齐起点微调。逐一定位与修复：

- **Bug：⇧ 大跳从来不生效**。键盘事件的 `e.key` 在 Shift 组合下给出的是
  修饰后的字符——`⇧+,` 是 `<`、`⇧+.` 是 `>`，而 `Annotator.tsx` 的 switch
  只写 `case ',' '.'`，带 Shift 的按键直接落空，`e.shiftKey` 那条 ×10 分支
  从未执行。帮助面板文案却已承诺 ⇧=100ms。
- **新增起点微调 `L` / `;`**（⇧ 为 100ms，与终点同模式）：`L` 起点提前
  （段变长）、`;` 起点延后（段变短）；光标位在 J/K 旁，方向与 hjkl 键盘簇
  一致。Shift 组合键名 `L` / `:` 一并接住。与 `[`（起点吸附）、`,`/`.`
  （终点微调）、`N`（新建说话人）、`M`（合并）均无冲突。
- 帮助面板（`?`）「边界」组与底部常驻条已同步；`USER_GUIDE.md` 快捷键表
  同步。最终键位：`L`/`;` 起点、`,`/`.` 终点、`[`/`]` 吸附、⇧ 统一 ×10。
- 验证：tsc 零错误、前端 59 passed；dev server（3001）热更后用户实测
  "生效了，手感也对了"。

### 遗留（未关闭）

- [x] **用户环境“播放无声音”——已解决（2026-09-05 用户确认，应用侧修复生效）**：
      根因是 boost>100% 时部分播放路径从不恢复 WebAudio 上下文（suspended 上下文内
      路由的元素播放无声）；2026-08-31 起波形 click/seek/空格/J/K/Enter 均会恢复，
      用户音量 >100% 复测通过、不再复现。系统输出设备/音量合成器排查线（spec §11）
      随之关闭——应用链路已排除，病因在应用侧。
- [x] **ModelScope 当日后端故障——已恢复（2026-09-05 验证）**：via verify 容器直接调
      `snapshot_download` 到临时目录拉取 `pretrained_eres2net_aug.ckpt`（221,210,095 B，
      9 文件全成），**md5 与本机 models 卷副本完全一致**（`640d8a6a…`）——官方路径通、
      本机副本字节级正确。注意：seed-models 脚本有"已存在即跳过"逻辑，重跑
      `seed-models` 只验证文件在场；验证 MS 路径必须新拉 + md5 对比（本次方法）。
      另：现存 `seed-models` 镜像未含 modelscope（旧构建），真正要用时先
      `docker compose --profile setup build seed-models`。
- [ ] 结论：`db+api` 最小部署不受影响；相似度依赖 verify，未启动时前端 503 文案提示。
- [ ] 三数据库/测试计数口径：本文件第七节的“服务端 96/前端 43”为**一期**数字；本期见上表。

### 九期：Alembic 迁移引入（2026-09-05）

一期 P2 遗留「动 schema 前先引入 Alembic」在本期闭环（二期字幕是第一个受益者）。
`server/app/schema.sql` 作废删除，**models.py 成为唯一事实来源**。

- **骨架**：`server/alembic.ini` + `server/migrations/{env.py,script.py.mako,versions/0001_baseline.py}`；
  env.py 的 URL 取自 `app.config.settings`（不写进 ini），CLI/容器/测试永不指向不同的库。
  pyproject 加 `alembic>=1.13`。
- **models.py 补齐镜像**：原是"schema.sql 优先 on drift"的次等镜像，现补上 5 个 Index
  （含两个部分索引 `ix_recordings_claimed_by`、`uq_jobs_active`）、`sha256` 改 `CHAR(64)`、
  全部服务端默认值（status/color/… 及 `gen_random_uuid()`）——metadata 与库做到逐项可比较。
- **0001 基线 = schema.sql 的幂等转写**（全 `IF NOT EXISTS`），而非 stamp 方案：老库
  （已有人工标注）在 `upgrade head` 下直接收敛——什么东西都不重建、不触碰数据；新库
  一步建全。`init_schema()` 三态归并为一条 `command.upgrade(head)`，外包 PG 会话级
  advisory lock（key 475104292）串行化三个容器同时启动的竞态（老 IF NOT EXISTS 引导
  的并发安全语义必须保留）。
- **验证**：新库 `adg_mig` upgrade+`alembic check` 零漂移；**真实 adg 库**
  （6 用户/3 说话人/10 段人工标注）init_schema 后计数与迁移前快照**逐一相同**、
  `alembic_version=0001_baseline`、check 干净；全量 `pytest -q` **128 passed**
  （126 原有 + 新 `tests/test_migrations.py` 2 项：check 零漂移、init_schema 幂等）。
- **顺手修掉一个过期测试**：`test_cannot_claim_before_pre_labels_exist` 自 e7ddc36
  （认领放宽到 `uploaded`）起就断言旧契约 409，从那时起一直在挂——按新契约改为
  `test_can_claim_before_pre_labels_exist`（200 + annotating）。
- **构建顺手加固**（本次事故）：清华镜像间歇性对个别包返回空 simple page
  （pip 报 `from versions: none`），build 层加 `PIP_EXTRA_INDEX_URL=阿里云` 兜底 + /srv
  安装改 `--no-build-isolation`（setuptools/wheel 预装进层），不再依赖隔离环境的
  二次拉取。**此次踩坑复刻了 HANDOFF 第五节「`docker build | tail` 掩盖退出码」**——
  第一次构建实际失败却显示成功（管道退出码来自 tail）。
- **今后改 schema 的流程**：改 `app/models.py` → `cd server && alembic revision
  --autogenerate -m "..."` → 下一容器启动（或 `docker compose up -d`)升级 → 测试
  `alembic check` 要求零漂移。**禁止手改数据库。**
