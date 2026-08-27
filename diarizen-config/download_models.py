"""Download the DiariZen checkpoint and speaker-embedding model into ./models.

Deliberately uses plain `requests` streaming rather than huggingface_hub. On this
machine huggingface_hub 1.x stalls behind the local proxy: its Xet backend opens
~28 parallel connections that the proxy cannot service, and disabling Xet still
leaves httpx hanging with zero bytes transferred. `requests` works fine.

Set HTTP_PROXY / HTTPS_PROXY if huggingface.co is not directly reachable.

    set HTTPS_PROXY=http://127.0.0.1:7890
    python download_models.py
"""

import os
import sys
import time
from pathlib import Path

import requests


HERE = Path(__file__).parent.resolve()
BASE = "https://huggingface.co/{repo}/resolve/main/{name}"

# The embedding directory MUST contain "pyannote": pyannote's PretrainedSpeakerEmbedding
# dispatches on substrings of the path and tests "pyannote" before "wespeaker". A path
# matching only "wespeaker" is routed to the ONNX loader, which cannot read these weights.
FILES = [
    ("BUT-FIT/diarizen-wavlm-large-s80-md", "config.toml", "diarizen-wavlm-large-s80-md"),
    ("BUT-FIT/diarizen-wavlm-large-s80-md", "config.json", "diarizen-wavlm-large-s80-md"),
    ("BUT-FIT/diarizen-wavlm-large-s80-md", "plda/plda.npz", "diarizen-wavlm-large-s80-md"),
    ("BUT-FIT/diarizen-wavlm-large-s80-md", "plda/xvec_transform.npz", "diarizen-wavlm-large-s80-md"),
    ("BUT-FIT/diarizen-wavlm-large-s80-md", "pytorch_model.bin", "diarizen-wavlm-large-s80-md"),
    ("pyannote/wespeaker-voxceleb-resnet34-LM", "config.yaml", "pyannote-wespeaker-voxceleb-resnet34-LM"),
    ("pyannote/wespeaker-voxceleb-resnet34-LM", "pytorch_model.bin", "pyannote-wespeaker-voxceleb-resnet34-LM"),
]

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
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    print(f"proxy: {proxy or '(none)'}")
    print(f"target: {HERE / 'models'}\n")

    session = requests.Session()
    failed = []

    for repo, name, subdir in FILES:
        url = BASE.format(repo=repo, name=name)
        dest = HERE / "models" / subdir / name
        try:
            download(url, dest, session)
        except Exception as exc:
            print(f"  FAILED  {name}: {type(exc).__name__}: {exc}")
            failed.append(name)

    if failed:
        print(f"\n{len(failed)} file(s) failed: {', '.join(failed)}")
        print("re-run to resume from where each left off.")
        return 1

    print("\nall models present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
