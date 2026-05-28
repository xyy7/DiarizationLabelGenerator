# 音频标签生成工具 - 项目架构文档

## 目录

- [项目概述](#项目概述)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [核心模块](#核心模块)
- [数据结构](#数据结构)
- [状态管理](#状态管理)
- [组件设计](#组件设计)

---

## 项目概述

音频标签生成工具是一个基于 React 的前端应用程序，主要用于：

1. 音频播放控制
2. 标签标记（说话人日志标记）
3. 字幕编辑
4. 多通道标签管理
5. 标签和字幕的导入导出

应用架构采用 React 18 + TypeScript 为核心，使用 Vite 作为构建工具，保证了高效的开发体验和良好的性能。

---

## 技术栈

| 技术 | 版本/用途 |
|-----|---------|
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite |
| UI 组件库 | Ant Design 5.x |
| 音频处理 | wavesurfer.js |
| 唯一 ID | uuid |
| 浏览器兼容 | 现代浏览器 (Chrome 90+, Firefox 88+, Edge 90+) |

### 依赖关系

主要依赖包在 `package.json` 中定义：

- `react`, `react-dom`: 核心 UI 渲染
- `wavesurfer.js`: 音频可视化和播放控制
- `antd`: UI 组件库
- `uuid`: 生成唯一标识符

---

## 目录结构

```
ADG/
├── public/
│   └── index.html
├── src/
│   ├── components/          # 组件目录
│   │   ├── AudioPlayer/     # 音频播放器组件
│   │   │   └── index.tsx
│   │   ├── Timeline/        # 时间轴/标签组件
│   │   │   └── index.tsx
│   │   ├── ChannelPanel/    # 通道面板组件
│   │   │   └── index.tsx
│   ├── store/               # 状态管理
│   │   └── index.tsx
│   ├── types/               # TypeScript 类型定义
│   │   └── index.ts
│   ├── utils/               # 工具函数
│   │   ├── index.ts
│   │   ├── label.ts         # 标签处理工具
│   │   └── subtitle.ts      # 字幕处理工具
│   ├── App.tsx              # 主应用组件
│   └── main.tsx             # 应用入口
├── test_data/               # 测试数据
├── .gitignore
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 核心模块

### 1. 音频处理模块

位置：`src/components/AudioPlayer/index.tsx`

主要功能：
- 音频加载和播放控制
- 波形可视化（使用 wavesurfer.js）
- 倍速播放（0.5x - 2.0x）
- 音量控制
- 进度控制
- 键盘快捷键支持
- 播放速度预设按钮

### 2. 标签管理模块

位置：`src/components/Timeline/index.tsx` 和 `src/utils/label.ts`

主要功能：
- 标签的创建、编辑、删除
- 标签拖动调整时间
- 标签文本编辑
- 标签设置弹窗（精确时间编辑）
- 标签导入导出（JSON）

### 3. 字幕管理模块

位置：`src/components/ChannelPanel/index.tsx` 和 `src/utils/subtitle.ts`

主要功能：
- 字幕的创建、编辑、删除
- SRT 格式导入导出
- 字幕时间轴管理

### 4. 通道管理模块

位置：`src/components/ChannelPanel/index.tsx`

主要功能：
- 多通道管理（每个通道一个说话人）
- 通道名称编辑
- 通道标签和字幕的关联

---

## 数据结构

### Subtitle 类型
```typescript
interface Subtitle {
  id: string;
  startTime: number; // 秒
  endTime: number;   // 秒
  text: string;
}
```

### Label 类型
```typescript
interface Label {
  id: string;
  channelId: string;
  startTime: number; // 秒
  endTime: number;   // 秒
  text: string;
  color?: string;
}
```

### Channel 类型
```typescript
interface Channel {
  id: string;
  name: string;
  color: string;
  labels: Label[];
  subtitles: Subtitle[];
}
```

### AudioFile 类型
```typescript
interface AudioFile {
  id: string;
  name: string;
  url: string;
  file?: File;
  duration?: number;
}
```

### Project 类型
```typescript
interface Project {
  id: string;
  name: string;
  audioFiles: AudioFile[];
  currentAudioId: string | null;
  channels: Channel[];
  createdAt: number;
  updatedAt: number;
}
```

### AppState 类型
```typescript
interface AppState {
  project: Project | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  volume: number;
}
```

---

## 状态管理

项目采用 React 原生 Context API + useReducer 实现状态管理，避免引入额外的状态管理库（如 Redux），保持项目简洁。

位置：`src/store/index.tsx`

### 状态逻辑

主要管理以下状态：
1. Project 数据（项目信息、音频文件、标签、字幕等）
2. 播放控制状态（播放/暂停、当前时间、音量、倍速等）

### Action 类型

- `CREATE_PROJECT`: 创建新项目
- `ADD_AUDIO_FILES`: 添加音频文件
- `SET_CURRENT_AUDIO`: 设置当前播放的音频
- `ADD_CHANNEL`: 添加通道
- `UPDATE_CHANNEL`: 更新通道
- `DELETE_CHANNEL`: 删除通道
- `ADD_LABEL`: 添加标签
- `UPDATE_LABEL`: 更新标签
- `DELETE_LABEL`: 删除标签
- `ADD_SUBTITLE`: 添加字幕
- `UPDATE_SUBTITLE`: 更新字幕
- `DELETE_SUBTITLE`: 删除字幕
- `SET_PLAYING`: 设置播放状态
- `SET_CURRENT_TIME`: 设置当前时间
- `SET_DURATION`: 设置总时长
- `SET_PLAYBACK_RATE`: 设置播放速度
- `SET_VOLUME`: 设置音量
- `LOAD_PROJECT`: 加载项目数据

### 数据持久化

使用 localStorage 实现自动保存功能，项目状态变化时会自动保存，页面加载时会尝试恢复上次保存的数据。

---

## 组件设计

### 1. App 组件

主要职责：
- 应用根组件
- 项目创建/加载逻辑
- 主 UI 布局（Header, Sider, Content）
- 音频文件导入导出
- 标签导入导出

### 2. AudioPlayer 组件

主要职责：
- 音频波形可视化
- 播放控制 UI
- 键盘快捷键处理
- 播放状态同步到 store

Props：
- `audioUrl`: 音频文件 URL

### 3. Timeline 组件

主要职责：
- 时间轴渲染
- 标签显示和交互
- 标签编辑 UI
- 标签设置弹窗

Props：
- `channel`: 通道数据
- `duration`: 音频总时长

### 4. ChannelPanel 组件

主要职责：
- 通道信息展示
- 标签和字幕标签页切换
- 字幕表格编辑
- 字幕导入导出

Props：
- `channel`: 通道数据
- `duration`: 音频总时长

---

## 工具函数

### 标签工具函数

位置：`src/utils/label.ts`

主要函数：
- `createLabel()`: 创建新标签
- `updateLabel()`: 更新标签
- `deleteLabel()`: 删除标签
- `exportLabels()`: 导出标签为 JSON
- `importLabels()`: 从 JSON 导入标签
- `getRandomColor()`: 生成随机通道颜色

### 字幕工具函数

位置：`src/utils/subtitle.ts`

主要函数：
- `createSubtitle()`: 创建新字幕
- `formatTime()`: 格式化时间为 SRT 格式
- `parseTime()`: 解析 SRT 格式时间
- `exportSRT()`: 导出字幕为 SRT
- `importSRT()`: 从 SRT 导入字幕

---

## 工作原理

### 音频播放流程

1. 用户导入音频文件
2. 文件 URL 传递给 AudioPlayer
3. wavesurfer.js 加载音频并渲染波形
4. 用户操作播放，状态同步到 store
5. 其他组件响应播放状态变化

### 标签标记流程

1. 用户在 Timeline 上拖动创建标签
2. 标签添加到对应 channel
3. 状态更新到 store，自动保存
4. 标签可拖动、编辑或删除

---

## 浏览器兼容性

- 使用 File API: 现代浏览器
- 使用 Canvas API: 波形渲染
- 使用 LocalStorage: 数据持久化
- 使用 CSS Grid/Flexbox: 布局

---

## 性能优化建议

1. 对于大文件音频：考虑流式加载
2. 对于大量标签：考虑虚拟滚动
3. 对于频繁更新：使用 React.memo 优化重渲染
4. 本地存储限制：考虑 IndexedDB 或文件系统存储（Chrome 扩展或 Electron）
