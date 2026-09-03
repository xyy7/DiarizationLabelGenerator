"""Fetch the eres2net checkpoint via the ModelScope SDK (run on the remote)."""
import os

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
          "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

from modelscope import snapshot_download  # noqa: E402

snapshot_download(
    "iic/speech_eres2net_sv_zh-cn_16k-common",
    local_dir="/root/autodl-tmp/adg/models/eres2net-sv-zh-cn-16k-common",
)
print("ERES_OK")
