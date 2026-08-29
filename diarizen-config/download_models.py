"""Download the DiariZen checkpoint and speaker-embedding model into ./models.

Deliberately uses plain `requests` streaming rather than huggingface_hub. On this
machine huggingface_hub 1.x stalls behind the local proxy: its Xet backend opens
~28 parallel connections that the proxy cannot service, and disabling Xet still
leaves httpx hanging with zero bytes transferred. `requests` works fine.

Set HTTP_PROXY / HTTPS_PROXY if huggingface.co is not directly reachable.

    set HTTPS_PROXY=http://127.0.0.1:7890
    python download_models.py
"""

import argparse
import os
import sys
import time
from pathlib import Path

import requests


HERE = Path(__file__).parent.resolve()
HF_BASE = "https://huggingface.co/{repo}/resolve/main/{name}"

# The embedding directory MUST contain "pyannote": pyannote's PretrainedSpeakerEmbedding
# dispatches on substrings of the path and tests "pyannote" before "wespeaker". A path
# matching only "wespeaker" is routed to the ONNX loader, which cannot read these weights.
FILES = [
    {"url": HF_BASE.format(repo="BUT-FIT/diarizen-wavlm-large-s80-md", name="config.toml"),
     "dest": "diarizen-wavlm-large-s80-md/config.toml"},
    {"url": HF_BASE.format(repo="BUT-FIT/diarizen-wavlm-large-s80-md", name="config.json"),
     "dest": "diarizen-wavlm-large-s80-md/config.json"},
    {"url": HF_BASE.format(repo="BUT-FIT/diarizen-wavlm-large-s80-md", name="plda/plda.npz"),
     "dest": "diarizen-wavlm-large-s80-md/plda/plda.npz"},
    {"url": HF_BASE.format(repo="BUT-FIT/diarizen-wavlm-large-s80-md", name="plda/xvec_transform.npz"),
     "dest": "diarizen-wavlm-large-s80-md/plda/xvec_transform.npz"},
    {"url": HF_BASE.format(repo="BUT-FIT/diarizen-wavlm-large-s80-md", name="pytorch_model.bin"),
     "dest": "diarizen-wavlm-large-s80-md/pytorch_model.bin"},
    {"url": HF_BASE.format(repo="pyannote/wespeaker-voxceleb-resnet34-LM", name="config.yaml"),
     "dest": "pyannote-wespeaker-voxceleb-resnet34-LM/config.yaml"},
    {"url": HF_BASE.format(repo="pyannote/wespeaker-voxceleb-resnet34-LM", name="pytorch_model.bin"),
     "dest": "pyannote-wespeaker-voxceleb-resnet34-LM/pytorch_model.bin"},
]

# ModelScope repo for the speaker-verification model. Downloaded with the
# modelscope SDK (snapshot_download), NOT by hand-rolling URLs: its per-file
# API is flaky and occasionally serves 404/500 from this network (observed
# 2026-08-29), while the SDK retries internally and downloads the same bytes
# fine (221 MB checkpoint, verified twice). The checkpoint really is
# pretrained_eres2net_aug.ckpt (3D-Speaker style, NOT pytorch_model.bin).
ERES_MODEL_ID = "iic/speech_eres2net_sv_zh-cn_16k-common"
ERES_DIR_NAME = "eres2net-sv-zh-cn-16k-common"

CHUNK = 1 << 20  # 1 MiB


def remote_size(url, session):
    resp = session.head(url, allow_redirects=True, timeout=30)
    resp.raise_for_status()
    return int(resp.headers.get("Content-Length", 0))


def download(url, dest, session):
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = remote_size(url, session)
    have = dest.stat().st_size if dest.exists() else 0

    if total and have == total:
        print(f"  ok      {dest.name}  ({total / 1e6:.1f} MB, already complete)")
        return

    headers = {"Range": f"bytes={have}-"} if have else {}
    mode = "ab" if have else "wb"
    if have:
        print(f"  resume  {dest.name}  from {have / 1e6:.1f} / {total / 1e6:.1f} MB")
    else:
        print(f"  get     {dest.name}  ({total / 1e6:.1f} MB)")

    t0 = time.perf_counter()
    with session.get(url, stream=True, headers=headers, timeout=60) as resp:
        resp.raise_for_status()
        with open(dest, mode) as fh:
            for chunk in resp.iter_content(chunk_size=CHUNK):
                fh.write(chunk)

    got = dest.stat().st_size
    dt = time.perf_counter() - t0
    rate = (got - have) / 1e6 / dt if dt > 0 else 0
    print(f"          -> {got / 1e6:.1f} MB in {dt:.0f}s ({rate:.2f} MB/s)")

    if total and got != total:
        raise RuntimeError(f"{dest.name}: expected {total} bytes, got {got}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dest",
        default=str(HERE / "models"),
        help="directory to download into (default: ./models next to this script)",
    )
    args = parser.parse_args()
    root = Path(args.dest)

    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    print(f"proxy: {proxy or '(none)'}")
    print(f"target: {root}\n")

    session = requests.Session()
    failed = []

    for entry in FILES:
        dest = root / entry["dest"]
        name = dest.name
        try:
            download(entry["url"], dest, session)
        except Exception as exc:
            print(f"  FAILED  {name}: {type(exc).__name__}: {exc}")
            failed.append(name)

    if failed:
        print(f"\n{len(failed)} file(s) failed: {', '.join(failed)}")
        print("re-run to resume from where each left off.")
        return 1

    # ModelScope via its own SDK. The seed image is built from the verify
    # target precisely because it carries modelscope (see docker-compose.yml).
    dest_dir = root / ERES_DIR_NAME
    try:
        from modelscope import snapshot_download
    except ImportError as exc:
        print(f"  FAILED  eres2net: modelscope is not installed: {exc}")
        print("  the seed image must be built from the `verify` target.")
        return 1

    print(f"  ms      {ERES_MODEL_ID}  ->  {dest_dir}")
    try:
        if not (dest_dir / "pretrained_eres2net_aug.ckpt").exists():
            snapshot_download(ERES_MODEL_ID, local_dir=str(dest_dir))
        else:
            print(f"  ok      pretrained_eres2net_aug.ckpt  (already complete)")
    except Exception as exc:
        print(f"  FAILED  eres2net: {type(exc).__name__}: {exc}")
        return 1

    print("\nall models present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
