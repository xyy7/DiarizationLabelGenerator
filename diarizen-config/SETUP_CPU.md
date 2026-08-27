# DiariZen CPU 环境配置说明

本机（Windows 11 + 仅 CPU）的实际安装记录。官方 README 的步骤假设有 CUDA，
以下是针对纯 CPU 和国内网络环境的调整版。

## 环境

conda 环境名 `diarizen`，Python 3.10：

```
C:\Users\Administrator\miniconda3\envs\diarizen\python.exe
```

已安装：`torch 2.1.1+cpu` / `torchaudio 2.1.1+cpu` / `torchvision 0.16.1+cpu`、
`numpy 1.26.4`、`pyannote.audio 3.1.1`（可编辑安装，来自仓库自带的 `pyannote-audio/`）、
`diarizen 0.0.1`（可编辑安装）。

## 运行

```powershell
conda activate diarizen
python run_example_cpu.py                    # 跑自带的 30s AMI 样例
python run_example_cpu.py path\to\your.wav   # 跑自己的音频
```

结果打印到终端，同时在 `example/` 下生成同名 `.rttm`。

输出与官方 README 示例中列出的前三行完全一致（README 只列到第三行就用 `...` 省略了），
共识别出 4 个说话人。30 秒音频在 10 线程 CPU 上推理约 31 秒（约 1x 实时）。

## 模型

权重放在 `models/` 下，不走 HuggingFace 缓存：

| 目录 | 内容 | 大小 |
|---|---|---|
| `models/diarizen-wavlm-large-s80-md/` | `pytorch_model.bin` + `config.toml` + `plda/` | 265 MB |
| `models/pyannote-wespeaker-voxceleb-resnet34-LM/` | 说话人嵌入模型 | 25 MB |

重新下载（支持断点续传）：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
python download_models.py
```

`s80` 是 80% 结构化剪枝版，WavLM 主干的剪枝后维度已硬编码在
`diarizen/models/module/wavlm_config.py`，**不需要另外下载 WavLM 预训练权重**。

## 三个踩过的坑

### 1. pip 会偷偷走系统代理，速度砍半

Windows 上 Python 的 `urllib.request.getproxies()` 在环境变量为空时会回退读注册表里的
WinINET 代理设置（本机 `127.0.0.1:7890` 是开着的），requests/pip 用的正是它。结果 pip 全程
走代理，从国内镜像下载反而变慢，甚至完全卡死。

实测同一个清华镜像的 torch wheel：

| 路径 | 速率 |
|---|---|
| 走代理（pip 默认行为） | 0.29 MB/s |
| 设 `NO_PROXY` 直连 | **1.57 MB/s** |

所以装包时要显式排除代理：

```powershell
$env:NO_PROXY = "pypi.tuna.tsinghua.edu.cn,mirrors.aliyun.com,files.pythonhosted.org,pypi.org,localhost,127.0.0.1"
pip install ... --index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

反过来，**HuggingFace 必须走代理**（直连不通，http 000）：HF 走代理 0.24 MB/s，
hf-mirror 直连 0.17 MB/s，hf-mirror 走代理只有 0.06 MB/s（代理把国内镜像绕出国了）。

### 2. huggingface_hub 1.x 在本机代理下会挂死

`from_pretrained` 拉不动权重：Xet 后端会开约 28 条并发连接把本地代理压垮，写入速率归零；
即使设 `HF_HUB_DISABLE_XET=1`，其 httpx 传输层仍然建了连接却一个字节都收不到。

`download_models.py` 因此改用 `requests` 流式下载（pip 已证明 requests 走代理正常）。
`run_example_cpu.py` 默认从本地 `models/` 目录构造 pipeline，绕开 HF hub。
需要走官方路径时可以加 `--hub`。

### 3. 嵌入模型的目录名必须含 "pyannote"

`pyannote/audio/pipelines/speaker_verification.py:744-758` 的 `PretrainedSpeakerEmbedding`
是按**路径子串**分发加载器的，顺序是 `pyannote` → `speechbrain` → `nvidia` → `wespeaker`。

官方 `hf_hub_download` 返回的缓存路径形如 `models--pyannote--wespeaker-...`，先命中
`"pyannote"` 走 PyTorch 加载器。如果本地目录只叫 `wespeaker-...`，就会落到 `"wespeaker"`
分支被当成 ONNX 模型，报 `INVALID_PROTOBUF`。

所以目录名保留为 `pyannote-wespeaker-voxceleb-resnet34-LM`。

## 与官方 requirements 的差异

`requirements-cpu.txt` 把 `onnxruntime-gpu` 换成了 CPU 版 `onnxruntime`。

实际安装时只装了推理链路需要的部分，跳过了纯训练用的
`jupyterlab / tensorboard / matplotlib / pesq / pystoi / thop / h5py / openpyxl / flit / pre-commit`
（当时带宽只有 0.5 MB/s）。要做训练或剪枝的话补装：

```powershell
pip install -r requirements-cpu.txt -c constraints.txt
```

另外 `diarizen/utils.py:14` 用了 `psutil`，但官方 `requirements.txt` 里没列，已单独装上。

## 未安装的部分

`dscore`（子模块，`git submodule update --init` 获取）只用于计算 DER 打分，跑推理用不到，
没有安装。
