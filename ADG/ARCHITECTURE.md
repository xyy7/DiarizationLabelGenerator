# ADG 前端架构

## 目录

- [项目概述](#项目概述)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [数据模型](#数据模型)
- [状态管理](#状态管理)
- [关键组件](#关键组件)
- [快捷键原则](#快捷键原则)

---

## 项目概述

ADG 是纠错式标注系统的**浏览器视图**。系统的对账本（system of record）在服务端
（仓库根目录 `../server/`，FastAPI + Postgres）：音频、标注、任务状态都归服务端管，
浏览器不持久化任何业务数据，刷新页面即从服务端重新装载。

三个设计取向：

1. **纠错优先**。DiariZen 先跑出预标注，标注员的主要动作是「改」而不是「画」，
   所以所有编辑操作都是纯函数（`annotation/operations.ts`），并配撤销栈。
2. **一条时间轴**。所有说话人共用同一根标尺与滚动位置，跨说话人的重叠一眼可见；
   旧版本每个说话人独立时间轴、独立缩放，是对齐看重叠不可行。
3. **键盘为纲**。标注是键盘活——走查（`J`/`K`）、改判（`1`–`9`）、拆分（`S`）、
   合并（`M`）、微调（`,`/`.`）、新建说话人（`N`）都绑定在手边。

## 技术栈

| 技术 | 用途 |
|---|---|
| React 18 + TypeScript | 视图 |
| Vite | 构建；dev 模式代理 `/api` → `localhost:8000` |
| Ant Design 5 | 组件库（工具栏、表格、弹窗） |
| wavesurfer.js 7 | 波形渲染与播放（渲染进 shadow DOM） |
| react-router-dom | `/`（列表）、`/rec/:id`（标注页） |
| vitest | 单元测试：编辑纯逻辑（operations/reducer） |

## 目录结构

```
ADG/
├── src/
│   ├── main.tsx               # 入口 + 路由
│   ├── types.ts               # 与服务端 API 对齐的类型（无本地数据模型）
│   ├── palette.ts             # 说话人配色，与服务端保持一致的常量
│   ├── api/client.ts          # REST 客户端：上传、认领、导入 RTTM、保存、导出
│   ├── pages/
│   │   ├── Workbench.tsx      # 列表页：上传、认领、导入 RTTM、删除、导出
│   │   └── Annotator.tsx      # 标注页：装载/保存、键盘、说话人面板、合并弹窗
│   ├── components/
│   │   ├── Timeline.tsx       # 共用时间轴：标尺 + 波形 + 每说话人一条轨道
│   │   ├── Waveform.tsx       # wavesurfer 封装
│   │   └── ShortcutHelp.tsx   # 快捷键面板（`?`）与常驻快捷条
│   └── annotation/
│       ├── operations.ts      # 纯编辑函数（无 React 依赖）
│       ├── operations.test.ts
│       ├── reducer.ts         # 编辑缓冲 + 撤销/重做（快照式，上限 200 步）
│       └── reducer.test.ts
├── scripts/                   # playwright-core 浏览器验证脚本（见 README）
├── index.html
├── vite.config.ts
└── package.json
```

## 数据模型

不存在前端的 `Label`/`Subtitle`/`Project`/`Channel` 等本地结构——那套模型随
客户端–服务端重构删除。`src/types.ts` 只是服务端 API 形状的镜像：

```typescript
interface Speaker { label: string; name: string; color: string; sort_order: number }
interface Segment  { id: string; speaker_label: string; start_sec: number; end_sec: number; text: string }
interface Recording { id; session_name; duration_sec; status; claimed_by; annotation_version; ... }
```

要点：

- **`label` 是稳定主键**，从不改动。DiariZen 发出的裸整数（`"0"`、`"3"`）原样保留，
  以便模型重跑仍然可比；重命名只碰 `name`。
- **`version` 是乐观锁**。保存时带上版本号，服务端发现过期则拒绝
  （`version_conflict`），标注页弹窗提示「有人先保存了」。
- `text` 字段保留给第二阶段（字幕），当前只跟随片段，不进入 RTTM 第 11 字段
  （标准 RTTM 为 10 字段，文本在 `ortho`）。

## 状态管理

- **不引入状态库**。编辑缓冲用一个 `useReducer`（`annotation/reducer.ts`），
  装载（`LOAD`）时从服务端拿快照，之后所有编辑动作以纯函数应用，产出一个新缓冲。
- **撤销/重做是快照式**：`past`/`future` 栈里存整份 `{speakers, segments, selectedId}`。
  一两个小对象数组的拷贝，字节数远比逆操作逻辑的复杂度便宜。
- **合并（coalesce）**：连续同类微调（拖边界、`/` 微调、重命名）只占一个撤销条目，
  不把上一步真操作埋进 50 个 nudge 里。
- **自动保存**：标注页监听 `dirty`，2 秒防抖；页面卸载前用 `beforeunload` 拦截。
- **`tempId()`**：新片段/新说话人先给客户端临时 id，保存成功由服务端赋予正式 id
  并回传 `version`（`SAVED`）。

## 关键组件

| 组件 | 职责 |
|---|---|
| `Workbench` | 状态列表（队列/认领人/版本），上传（流式哈希去重），导入 RTTM（文件名不符时要求确认），导出 zip |
| `Annotator` | 装载（录音 + 标注 + 波形峰值），键盘分发，保存/冲突处理，说话人面板（改名、`N` 新建、合并到…），缩放 |
| `Timeline` | 一根标尺 + 每说话人一条轨道 + 跨轨道播放头。拖轨道空白新建片段，拖片段移动，拖边缘改边界。宽度 = `duration × pxPerSec`，同一滚动容器 |
| `Waveform` | wavesurfer 7 封装；峰值由服务端计算（100 点/秒），避免前端下载整段波形 |
| `ShortcutHelp` | `?` 打开的完整快捷键面板 + 常驻一行快捷条；`Tab` 特意不绑（留给键盘焦点） |

布局上波形与四条轨道的对齐经过脚本实测（`interact.mjs` 读取 DOM 矩形断言
`dx=0 dw=0`），这是防「各说话人时间轴错位」回退的手段。

## 快捷键原则

- `1`–`9` = 改判给第 N 位说话人（旧版是播放倍速；倍速让位给 `-`/`=`）。
- `Tab` 不绑任何功能——它是键盘焦点唯一的移动方式，绑走了页面就没有控件可达。
- 数字键与改判的对应关系（`speakers[Number(e.key) - 1]`）变化时，`1`–`9` 的
  帮助文案、`1` 到 `9` 之外说话人的到达方式（`N` + 数字键）要同步检查。
- 快捷键清单的唯一事实来源是 `ShortcutHelp.tsx` 的 `GROUPS`；新快捷键必须先改它。
