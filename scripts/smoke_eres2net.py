"""Smoke test for iic/speech_eres2net_sv_zh-cn_16k-common (Task 1, temporary).

Downloads the model once into %TEMP%/eres2net-smoke, then tries to:
  1. load the official modelscope speaker-verification pipeline offline,
  2. obtain a 192-dim embedding from a 16k mono wav window,
  3. sanity-check: heavily-overlapping same-speech windows score higher
     than a distant range.

The point is to DECIDE whether verify/engine.py can use the modelscope
pipeline directly or must vendor 3D-Speaker's ERes2Net code.
"""

import os
import sys
import tempfile
from pathlib import Path

MODEL_ID = "iic/speech_eres2net_sv_zh-cn_16k-common"
MODEL_DIR = Path(tempfile.gettempdir()) / "eres2net-smoke" / "model"
WAV = Path(__file__).resolve().parent.parent / "DiariZen/example/EN2002a_30s.wav"


def main() -> int:
    from modelscope import snapshot_download

    if not (MODEL_DIR / "pytorch_model.bin").exists():
        print(f"downloading {MODEL_ID} -> {MODEL_DIR} ...")
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        snapshot_download(MODEL_ID, local_dir=str(MODEL_DIR))
    else:
        print(f"model already at {MODEL_DIR}")

    files = [f.name for f in MODEL_DIR.iterdir()]
    print("repo files:", files)

    import torch

    torch.set_num_threads(max(1, (os.cpu_count() or 8) - 2))

    from modelscope.pipelines import pipeline

    print("loading pipeline from local dir ...")
    # modelscope 1.39 dropped modelscope.tasks; the task name as a string is
    # the stable form anyway.
    sv = pipeline("speaker-verification", model=str(MODEL_DIR))
    print("pipeline type:", type(sv).__name__)

    # --- discovery of the embedding API -------------------------------
    print("\n--- discovery ---")
    for name in ("model", "am_model", "tokenizer", "cfg", "config"):
        obj = getattr(sv, name, None)
        if obj is None:
            continue
        print(f"sv.{name}: {type(obj).__name__}")
        for attr in dir(obj):
            if any(k in attr.lower() for k in ("embed", "feat", "forward", "encode", "am")):
                print(f"    .{attr}  -> {type(getattr(obj, attr)).__name__}")

    # --- pairwise score through the official API ----------------------
    print("\n--- official pair score ---")
    for a, b, label in [
        ((2.0, 5.0), (2.5, 5.5), "same-ish window"),
        ((2.0, 5.0), (25.0, 29.0), "distant window"),
    ]:
        try:
            out = sv(str(WAV), str(WAV), a[0], a[1], b[0], b[1])
            print(label, "->", {k: v for k, v in out.items()})
        except TypeError:
            # older API takes (wav1, wav2) scipy arrays or paths directly
            out = sv([str(WAV), str(WAV)])
            print("fallback pair call ->", {k: v for k, v in out.items()})
            break

    # --- embedding extraction via the model's own forward -------------
    print("\n--- embedding extraction ---")
    import numpy as np
    import soundfile as sf

    model_obj = getattr(sv, "model", None)
    data, sr = sf.read(WAV, dtype="float32")  # model expects float32, not soundfile's float64

    def embed(start: float, end: float):
        seg = data[int(start * sr): int(end * sr)]
        with torch.no_grad():
            out = model_obj.forward(seg)  # [1, T] float32 -> [1, 192] tensor
        emb = out.detach().cpu().numpy()[0]
        emb = emb / (np.linalg.norm(emb) + 1e-9)  # L2 normalize
        return emb

    a = embed(2.0, 5.0)
    a2 = embed(2.5, 5.5)   # same utterance, shifted 0.5 s
    b = embed(25.0, 29.0)  # distant range, very likely another speaker
    print("a:", a.shape, "a2:", a2.shape, "b:", b.shape)
    print("cos(a, a2) same-window :", float(np.dot(a, a2)))
    print("cos(a, b)  distant     :", float(np.dot(a, b)))
    print("cos(a2, b) distant     :", float(np.dot(a2, b)))

    ok = a.shape == (192,) and float(np.dot(a, a2)) > 0.6
    print("\nRESULT: embedding extraction", "OK" if ok else "SUSPECT")

    return 0


if __name__ == "__main__":
    sys.exit(main())
