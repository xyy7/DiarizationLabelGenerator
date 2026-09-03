"""Remote smoke test for the real worker path (config_parse, batch 32)."""
import os
import sys
import time

os.environ.setdefault("MODELS_DIR", "/root/autodl-tmp/adg/models")
os.environ.setdefault("TORCH_NUM_THREADS", "8")
sys.path.insert(0, "/srv")

from app.worker.diarize import diarize  # noqa: E402

t0 = time.perf_counter()
rttm = diarize("/opt/diarizen/DiariZen/example/EN2002a_30s.wav", "worker_smoke")
dt = time.perf_counter() - t0
lines = [l for l in rttm.strip().splitlines() if l]
print(f"WORKER_SMOKE_OK rttm_lines={len(lines)} seconds={dt:.1f}")
