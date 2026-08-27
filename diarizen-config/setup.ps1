<#
.SYNOPSIS
    拉取 DiariZen 上游仓库并配置纯 CPU 推理环境。

.DESCRIPTION
    复现 SETUP_CPU.md 里记录的安装过程。上游代码不入库，由本脚本 clone 到
    仓库根目录的 DiariZen/ 下，再把本目录的脚本拷进去。

    注意两条相反的网络策略（原因见 SETUP_CPU.md）：
      - PyPI  走国内镜像、必须绕开代理（pip 在 Windows 上会经注册表偷走系统代理）
      - HuggingFace 必须走代理（直连不通）

.PARAMETER Proxy
    HuggingFace 下载用的代理地址。设为空字符串则直连（多数国内网络会失败）。

.PARAMETER EnvName
    conda 环境名，默认 diarizen。

.PARAMETER SkipModels
    只装环境，不下载 291 MB 权重。

.EXAMPLE
    .\setup.ps1
    .\setup.ps1 -Proxy "http://127.0.0.1:1080" -EnvName diar
#>
param(
    [string]$Proxy = "http://127.0.0.1:7890",
    [string]$EnvName = "diarizen",
    [switch]$SkipModels
)

$ErrorActionPreference = "Stop"

$ConfigDir = $PSScriptRoot
$RepoRoot = Split-Path $ConfigDir -Parent
$DiariZen = Join-Path $RepoRoot "DiariZen"
$Index = "https://pypi.tuna.tsinghua.edu.cn/simple"

# pip 在 Windows 上会经注册表回退读 WinINET 代理设置，从国内镜像下载反而变慢甚至卡死。
$NoProxyHosts = "pypi.tuna.tsinghua.edu.cn,mirrors.aliyun.com,mirrors.ustc.edu.cn,files.pythonhosted.org,pypi.org,localhost,127.0.0.1"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---------- 1. 上游仓库 ----------
Step "获取 DiariZen 上游仓库"
if (Test-Path (Join-Path $DiariZen ".git")) {
    Write-Host "已存在，跳过 clone: $DiariZen"
} else {
    git clone https://github.com/BUTSpeechFIT/DiariZen.git $DiariZen
    if ($LASTEXITCODE -ne 0) { throw "clone 失败" }
}

# ---------- 2. conda 环境 ----------
Step "创建 conda 环境 $EnvName (Python 3.10)"
$envPath = (conda env list) | Select-String -Pattern "^\s*$EnvName\s"
if ($envPath) {
    Write-Host "环境已存在，跳过创建"
} else {
    conda create --name $EnvName python=3.10 -y
    if ($LASTEXITCODE -ne 0) { throw "conda create 失败" }
}

$condaBase = (conda info --base).Trim()
$Py = Join-Path $condaBase "envs\$EnvName\python.exe"
if (-not (Test-Path $Py)) { throw "找不到解释器: $Py" }
Write-Host "解释器: $Py"

# ---------- 3. 依赖 ----------
# 装包全程绕开代理，走清华镜像。
$env:NO_PROXY = $NoProxyHosts
$env:no_proxy = $NoProxyHosts
$env:HTTP_PROXY = ""
$env:HTTPS_PROXY = ""

Step "安装 CPU 版 PyTorch 2.1.1"
# Windows 上 PyPI 的 torch wheel 本身就是 CPU 构建，无需 download.pytorch.org
& $Py -m pip install torch==2.1.1 torchvision==0.16.1 torchaudio==2.1.1 --progress-bar off --index-url $Index
if ($LASTEXITCODE -ne 0) { throw "torch 安装失败" }

Step "安装 pyannote-audio（仓库自带，可编辑安装）"
& $Py -m pip install -e (Join-Path $DiariZen "pyannote-audio") -c (Join-Path $DiariZen "constraints.txt") --progress-bar off --index-url $Index
if ($LASTEXITCODE -ne 0) { throw "pyannote-audio 安装失败" }

Step "安装 diarizen 及推理依赖"
# psutil 被 diarizen/utils.py 使用，但上游 requirements.txt 漏列了。
& $Py -m pip install -e $DiariZen toml "accelerate==1.6.0" psutil librosa torchinfo onnxruntime `
    -c (Join-Path $DiariZen "constraints.txt") --progress-bar off --index-url $Index
if ($LASTEXITCODE -ne 0) { throw "diarizen 安装失败" }

# ---------- 4. 拷入配置脚本 ----------
Step "拷入 CPU 推理脚本"
foreach ($f in @("run_example_cpu.py", "download_models.py", "requirements-cpu.txt", "SETUP_CPU.md")) {
    Copy-Item (Join-Path $ConfigDir $f) (Join-Path $DiariZen $f) -Force
    Write-Host "  $f"
}

# ---------- 5. 权重 ----------
if ($SkipModels) {
    Step "按 -SkipModels 跳过权重下载"
} else {
    Step "下载预训练权重（约 291 MB，走代理）"
    # HuggingFace 直连不通，这一步必须走代理。
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    $env:NO_PROXY = "localhost,127.0.0.1"
    & $Py (Join-Path $DiariZen "download_models.py")
    if ($LASTEXITCODE -ne 0) { throw "权重下载失败，重跑本脚本可断点续传" }
}

# ---------- 完成 ----------
Write-Host "`n配置完成。验证：" -ForegroundColor Green
Write-Host "  conda activate $EnvName"
Write-Host "  cd `"$DiariZen`""
Write-Host "  python run_example_cpu.py"
