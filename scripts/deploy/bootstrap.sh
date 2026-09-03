#!/usr/bin/env bash
# One-shot bootstrap for the ADG stack on a bare AutoDL container (no docker).
# Mirrors server/docker/Dockerfile: api deps + torch + vendored DiariZen +
# modelscope for the verify service. Idempotent: re-running skips finished work.
set -euo pipefail

BASE=/root/autodl-tmp/adg
VENV=$BASE/venv
MODELS=$BASE/models
PKG=/root/autodl-tmp/adg-deploy.tar.gz
PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple

echo "== extract code =="
mkdir -p /srv /opt/diarizen "$BASE/logs" "$MODELS" "$BASE/data"
rm -rf /tmp/adg-extract && mkdir -p /tmp/adg-extract
tar -xzf "$PKG" -C /tmp/adg-extract
rm -rf /opt/diarizen/DiariZen
mv /tmp/adg-extract/DiariZen /opt/diarizen/DiariZen
rm -rf /srv/app /srv/static
mv /tmp/adg-extract/server/app /srv/app
mv /tmp/adg-extract/ADG/dist /srv/static
mv /tmp/adg-extract/server/pyproject.toml /srv/pyproject.toml
mkdir -p /srv/scripts
mv /tmp/adg-extract/diarizen-config/download_models.py /srv/scripts/download_models.py
mv /tmp/adg-extract/server/docker/init-test-db.sql /srv/scripts/init-test-db.sql

echo "== postgres =="
if ! command -v psql >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql
fi
service postgresql start || pg_ctlcluster 14 main start
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='adg'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE ROLE adg LOGIN PASSWORD 'adg'\""
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='adg'\"" | grep -q 1 \
  || su postgres -c "createdb -O adg adg"
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='adg_test'\"" | grep -q 1 \
  || su postgres -c "createdb -O adg adg_test"

echo "== venv + python deps =="
PYTHON=${PYTHON:-/root/miniconda3/bin/python3}
# --system-site-packages: the AutoDL base env already ships torch 2.1.2+cu121
# (verified cuda.is_available()); do not download another 670 MB torch wheel.
"$PYTHON" -m venv --system-site-packages "$VENV"
PIP="$VENV/bin/pip install --index-url $PIP_INDEX --no-cache-dir"
$PIP "numpy>=1.26,<2" soundfile "av>=11,<14" fastapi "uvicorn[standard]" \
     "psycopg[binary]" sqlalchemy python-multipart httpx
$PIP torchaudio==2.1.2
$PIP toml psutil accelerate==1.6.0
$PIP -e /opt/diarizen/DiariZen/pyannote-audio -c /opt/diarizen/DiariZen/constraints.txt
$PIP -e /opt/diarizen/DiariZen
$PIP "modelscope>=1.38,<1.42" addict simplejson "datasets>=3" requests

# The academic accelerator serves huggingface.co at ~0.2 MB/s from this box,
# while hf-mirror.com (Aliyun edge) does ~3 MB/s. The fetcher supports Range
# resume, so partial files keep what they already have. Remote copy only.
echo "== models: hf-mirror.com direct + ModelScope direct (no proxy) =="
sed -i 's|https://huggingface.co/|https://hf-mirror.com/|' /srv/scripts/download_models.py
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
"$VENV/bin/python" /srv/scripts/download_models.py --dest "$MODELS"

echo "== bootstrap done =="
