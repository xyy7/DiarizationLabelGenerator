# DiarizationLabelGenerator

说话人分离（speaker diarization）标注工具。由两部分组成：

| 目录 | 内容 |
|---|---|
| `ADG/` | 前端标注应用（Vite + TypeScript），手动标注说话人通道与时间段 |
| `diarizen-config/` | [DiariZen](https://github.com/BUTSpeechFIT/DiariZen) 的纯 CPU 环境配置与推理脚本 |

目前两部分**尚未集成**：ADG 是纯手动标注，DiariZen 可独立跑出 RTTM。
把 DiariZen 的输出接进 ADG 作为预标注，是后续工作。

## ADG（标注应用）

```bash
cd ADG
npm install
npm run dev
```

用法见 `ADG/USER_GUIDE.md`，架构见 `ADG/ARCHITECTURE.md`。

## DiariZen（自动说话人分离）

DiariZen 上游代码体积较大且有独立的 git 历史，**不纳入本仓库**。
用配置目录里的脚本自动拉取并配置：

```powershell
cd diarizen-config
.\setup.ps1
```

脚本会依次完成：clone 上游仓库 → 建 conda 环境 → 装 CPU 版依赖 → 拷入本目录的脚本
→ 下载预训练权重（约 291 MB）。完成后：

```powershell
conda activate diarizen
cd ..\DiariZen
python run_example_cpu.py                    # 跑自带的 30s 样例
python run_example_cpu.py path\to\your.wav   # 跑自己的音频
```

输出打印到终端，同时生成同名 `.rttm`（标准说话人分离标注格式）。

30 秒音频在 10 线程 CPU 上推理约 31 秒（约 1x 实时）。

安装细节、实测网络速率对比、以及三个容易踩的坑，见
[`diarizen-config/SETUP_CPU.md`](diarizen-config/SETUP_CPU.md)。

## 许可

- `ADG/` 为本项目自有代码。
- DiariZen 代码为 MIT，但其**预训练权重是 CC BY-NC 4.0，仅限研究与学术用途，不可商用**。
  若本工具需要商用，必须替换权重或另行取得授权。
