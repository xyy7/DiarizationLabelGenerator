# Multi-stage: `api` is small and torch-free, `worker` adds torch + the
# vendored DiariZen trees. Both share the base and application layers.
#
# Build context is the REPOSITORY ROOT, not server/, because the worker stage
# needs DiariZen/ copied in.

# ---------------------------------------------------------------- base -----
FROM python:3.10-slim AS base

# PyPI direct is slow from here; override with --build-arg PIP_INDEX_URL=... to
# use the default index.
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PYTHONPATH=/srv

# No apt layer at all. Decoding and resampling come from PyAV, whose manylinux
# wheel bundles FFmpeg's libraries, and libsndfile ships inside the soundfile
# wheel. Installing Debian's `ffmpeg` instead would pull in 150+ packages --
# SDL2, X11, cairo, all of it for `ffplay`, which we never run -- over a link
# that drops connections partway through.

WORKDIR /srv

# ----------------------------------------------------------------- api -----
FROM base AS api

# Heavy wheels first, one RUN each. A failed RUN caches nothing, so on a link
# that drops connections mid-download this is the difference between a retry
# resuming and a retry starting over from the 33 MB PyAV wheel every time.
# Versions here only warm the cache; pyproject below is what actually pins.
RUN pip install --no-cache-dir "av>=11,<14"
RUN pip install --no-cache-dir "numpy>=1.26,<2" "soundfile>=0.12"
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" "psycopg[binary]"
RUN pip install --no-cache-dir sqlalchemy python-multipart

# Dependencies resolved from pyproject alone, against an empty package, so
# editing application code does not invalidate the layer. The real app/ is
# copied afterwards and imported via PYTHONPATH.
COPY server/pyproject.toml /srv/pyproject.toml
RUN mkdir -p /srv/app && touch /srv/app/__init__.py \
 && pip install --no-cache-dir /srv

COPY server/app /srv/app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# -------------------------------------------------------------- worker -----
FROM api AS worker

# Build-time torch flavour. Default CPU: the PyPI wheel bundles CUDA (~800 MB)
# and is pure waste on a CPU-only box. GPU machines build with
# `--build-arg TORCH_VARIANT=cu118` (torch 2.1.1's CUDA 11.8 wheel).
ARG TORCH_VARIANT=cpu
RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/${TORCH_VARIANT} \
      torch==2.1.1 torchvision==0.16.1 torchaudio==2.1.1

# The vendored pyannote-audio is MODIFIED upstream (it adds VBxClustering,
# which diarizen imports). Installing the PyPI package instead silently
# produces a pipeline that cannot cluster. Both trees are editable installs,
# so the source has to stay in the image at runtime.
COPY DiariZen /opt/diarizen/DiariZen
# DiariZen's pyproject declares no runtime dependencies; its README installs
# requirements.txt, which the image never does. The inference path needs all
# three (trainer-only ones like librosa/torchinfo/h5py/thop are deliberately
# NOT installed -- the worker only runs inference):
#   toml       -- pipelines/inference.py:11
#   psutil     -- diarizen/utils.py:14 (imported by pyannote.audio.core.model)
#   accelerate -- diarizen/utils.py:17 (module-level; the whole utils import)
# Fixed the hard way 2026-09-04: verify never imports these paths, so the
# missing deps hid until the worker started for the first time.
RUN pip install --no-cache-dir toml psutil accelerate==1.6.0 \
 && pip install --no-cache-dir -e /opt/diarizen/DiariZen/pyannote-audio \
      -c /opt/diarizen/DiariZen/constraints.txt \
 && pip install --no-cache-dir -e /opt/diarizen/DiariZen

# `requests` is for the weight fetcher only. It deliberately avoids
# huggingface_hub, which stalls behind a proxy (see the script's docstring).
RUN pip install --no-cache-dir requests
COPY diarizen-config/download_models.py /srv/scripts/download_models.py

# Weights are NOT baked in: they are CC BY-NC 4.0 (research use only), so
# keeping them out of the image keeps the image itself redistributable. The
# seed-models service populates the shared volume instead.
CMD ["python", "-m", "app.worker.worker"]

# -------------------------------------------------------------- verify -----
# Speaker-verification service (eres2net): the same torch image as the worker
# plus modelscope's runtime, run as its own uvicorn app on :8001. The API
# calls it; the browser never does.
FROM worker AS verify

# modelscope <=1.39 does not declare its runtime deps in PyPI metadata
# (verified the hard way, 2026-08-29); pip install modelscope alone leaves
# the package import-broken. Pin the three it actually needs.
RUN pip install --no-cache-dir "modelscope>=1.38,<1.42" \
      addict simplejson "datasets>=3"

EXPOSE 8001
CMD ["uvicorn", "app.verify.server:app", "--host", "0.0.0.0", "--port", "8001"]

# ---------------------------------------------------------------- test -----
# Built from `api`, not `worker`: the suite stubs the pipeline rather than
# loading 292 MB of weights, so it needs no torch and stays fast.
FROM api AS test

RUN pip install --no-cache-dir pytest httpx
COPY server/tests /srv/tests

CMD ["pytest", "-q"]
