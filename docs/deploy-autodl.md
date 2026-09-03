# 远程 GPU 部署（AutoDL 裸机）

本仓库的 docker compose 流程面向本地/有 docker 的机器。AutoDL 容器**不允许
docker**，因此部署脚本按 `server/docker/Dockerfile` 的配方在裸机上复刻同一
套服务（db / api / worker / verify）。

## 布局

| 路径 | 内容 |
|---|---|
| `/srv` | `app/`（server 代码）、`static/`（ADG 前端构建产物）、`scripts/download_models.py` |
| `/opt/diarizen/DiariZen` | vendored DiariZen + pyannote-audio（editable 安装） |
| `/root/autodl-tmp/adg/venv` | Python 虚拟环境（`--system-site-packages`，复用镜像自带 torch 2.1.x+cu121） |
| `/root/autodl-tmp/adg/models` | DiariZen / wespeaker / eres2net 权重 |
| `/root/autodl-tmp/adg/data` | 音频与导出（DATA_DIR） |
| `/root/autodl-tmp/adg/logs` | 各服务日志 |

Postgres 14 由 apt 安装，账号 `adg`/`adg`，库 `adg`（+ 测试库 `adg_test`）。

## 服务与端口

- `api` —— uvicorn 绑定 **6006**（AutoDL「自定义服务」只映射 6006/6008）；
- `verify` —— 8001，仅本机，API 经 `VERIFY_URL` 内部调用；
- `worker` —— DiariZen 预标注队列；GPU 自动用 `batch_size=32`
  （CPU 机器回落为 4，可用 `DIARIZEN_BATCH_SIZE` 覆盖，见
  `server/app/worker/diarize.py`）。

全部跑在 tmux 会话里（api / verify / worker），日志写
`/root/autodl-tmp/adg/logs/<name>.log`。

## 日常操作（SSH 上实例后）

```bash
bash /root/autodl-tmp/start_services.sh   # 启动/补齐全部服务（实例重启后跑一次）
tmux ls                                   # 看会话
tmux attach -t worker                     # 看实时输出（Ctrl+B D 退出）
curl -s localhost:6006/healthz            # api + db
curl -s localhost:8001/healthz            # verify（模型加载成功才 ok）
```

## 权重下载

`/srv/scripts/download_models.py` 即 `diarizen-config/download_models.py`
的远程副本，HF 域名被替换为 hf-mirror.com（AutoDL 学术加速对 HF 只有
~0.2 MB/s，hf-mirror 实测 ~4.4 MB/s；ModelScope 国内直连 ~12 MB/s）。

## 访问

- 公网：AutoDL 控制台 → 实例 → 自定义服务（映射容器 6006）；
- 本地：`ssh -p <port> -L 8000:127.0.0.1:6006 root@<host>` 后访问
  `http://localhost:8000`。

## 部署脚本

`scripts/deploy/`（本仓库）+ `scripts/remote_ssh.py`（含 SSH 凭据，
已加入 .gitignore，不入库）：`bootstrap.sh` 幂等重装环境，`start_services.sh`
启动服务，`smoke_*.py` 做部署后冒烟。
