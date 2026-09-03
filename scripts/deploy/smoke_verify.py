"""Remote smoke test for the verify engine: embed two windows of a wav."""
import sys

sys.path.insert(0, "/srv")

from app.config import Settings  # noqa: E402
import app.config  # noqa: E402

# Point settings at the deployed layout before anything caches them.
app.config.settings = Settings(
    models_dir="/root/autodl-tmp/adg/models",
)
import app.verify.engine as engine  # noqa: E402
from app.verify.engine import embed  # noqa: E402

wav = "/opt/diarizen/DiariZen/example/EN2002a_30s.wav"
v1 = embed(wav, 0.0, 5.0)
v2 = embed(wav, 0.0, 5.0)
import numpy as np  # noqa: E402

same = float(np.dot(v1, v2))
diff = float(np.dot(v1, embed(wav, 15.0, 20.0)))
print(f"dim={v1.shape[0]} same-window cos={same:.4f} diff-window cos={diff:.4f}")
assert v1.shape[0] == 192 and same > 0.999
print("VERIFY_SMOKE_OK")
