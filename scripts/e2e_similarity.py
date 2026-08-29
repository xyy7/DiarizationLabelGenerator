"""End-to-end exercise of the speaker-verification feature against a live
`docker compose` stack. Temporary verification script (Task 9-11).

Creates its OWN recording (a trimmed copy of DiariZen's example wav, so it
cannot collide with an existing annotation), writes an annotation with three
speakers and two stable segments, then asks /similarity for a window that
belongs to the same person as one of the stable segments and checks that the
rankings look sane. Finally performs an overlap reassign (PUT + RTTM) and
displays the two overlapping lines.

    python scripts/e2e_similarity.py [base_url]   # default http://localhost:8000
"""

from __future__ import annotations

import math
import sys
import wave
from pathlib import Path

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
HEADERS = {"X-User-Name": "e2e-check"}

SRC = Path(__file__).resolve().parent.parent / "DiariZen/example/EN2002a_30s.wav"
TMP = Path(__file__).resolve().parent / "e2e_tmp_trimmed.wav"


def trim(src: Path, dst: Path, drop_first: float = 1.0) -> None:
    """Drop the first second so the sha256 differs from any existing row."""
    with wave.open(str(src), "rb") as r:
        frames = r.readframes(r.getnframes())
        start = int(drop_first * r.getframerate() * r.getnchannels())
        with wave.open(str(dst), "wb") as w:
            w.setparams(r.getparams())
            w.writeframes(frames[start:])


def main() -> int:
    trim(SRC, TMP)
    with TMP.open("rb") as fh:
        resp = requests.post(
            f"{BASE}/api/recordings",
            files={"file": ("e2e_trimmed.wav", fh, "audio/wav")},
            headers=HEADERS,
            timeout=60,
        )
    if resp.status_code == 409:
        rid = resp.json()["detail"]["existing_id"]
        print(f"reusing existing recording {rid}")
    elif resp.status_code == 201:
        rid = resp.json()["id"]
        print(f"recording {rid} status={resp.json()['status']}")
    else:
        print("upload failed", resp.status_code, resp.text)
        return 1

    version = requests.get(
        f"{BASE}/api/recordings/{rid}/annotation", headers=HEADERS, timeout=30,
    ).json()["version"]

    ann = {
        "version": version,
        "speakers": [
            {"label": "0", "name": "A", "color": "#1890ff", "sort_order": 0},
            {"label": "1", "name": "B", "color": "#52c41a", "sort_order": 1},
            {"label": "2", "name": "C", "color": "#faad14", "sort_order": 2},
        ],
        "segments": [
            # Window [2.0,5.0] and [2.5,5.5] are the same voice (smoke-verified
            # cos ≈ 0.94); [25,29] is a different voice. Label the suspect one
            # WRONGLY (speaker C) and let the ranking expose the truth.
            {"speaker_label": "0", "start_sec": 2.0, "end_sec": 5.0, "text": "", "is_stable": True},
            {"speaker_label": "1", "start_sec": 12.0, "end_sec": 15.0, "text": "", "is_stable": True},
            {"speaker_label": "2", "start_sec": 25.0, "end_sec": 28.5, "text": "", "is_stable": True},
            {"speaker_label": "2", "start_sec": 2.2, "end_sec": 5.2, "text": "", "is_stable": False},
        ],
    }
    resp = requests.put(
        f"{BASE}/api/recordings/{rid}/annotation", json=ann, headers=HEADERS, timeout=30,
    )
    print("annotation saved:", resp.status_code, resp.text[:160])
    if resp.status_code != 200:
        return 1
    version = resp.json()["version"]  # server's new version for the next PUT

    resp = requests.post(
        f"{BASE}/api/recordings/{rid}/similarity",
        json={"start_sec": 2.2, "end_sec": 5.2},
        headers=HEADERS,
        timeout=120,
    )
    if resp.status_code != 200:
        print("similarity FAILED:", resp.status_code, resp.text)
        print("did you `docker compose up -d verify`?")
        return 1
    body = resp.json()
    print(f"\nsimilarity for [2.2-5.2] (truth: speaker A) in {body['elapsed_ms']} ms:")
    for item in body["items"]:
        clips = ", ".join(f"{c['score']:.0f}%[:{c['start_sec']}-{c['end_sec']}]" for c in item["clips"])
        print(f"  {item['name']:<10} best={item['best_score']:>5.1f}  {clips}")
    if body["unranked"]:
        print("  unranked:", [u["name"] for u in body["unranked"]])

    # Overlap: reassign the suspect to A AND C simultaneously (two segments
    # share the window) -> PUT + export, then show the overlapping RTTM lines.
    # The next PUT carries the version just returned (optimistic lock).
    new_segments = [
        {"speaker_label": "0", "start_sec": 2.0, "end_sec": 5.0, "text": "", "is_stable": True},
        {"speaker_label": "1", "start_sec": 12.0, "end_sec": 15.0, "text": "", "is_stable": True},
        {"speaker_label": "2", "start_sec": 25.0, "end_sec": 28.5, "text": "", "is_stable": True},
        {**ann["segments"][3], "speaker_label": "0"},
        {**ann["segments"][3], "speaker_label": "2"},
    ]
    resp = requests.put(
        f"{BASE}/api/recordings/{rid}/annotation",
        json={"version": version, "speakers": ann["speakers"], "segments": new_segments},
        headers=HEADERS,
        timeout=30,
    )
    print("\noverlap reassign saved:", resp.status_code, resp.text[:120])
    assert resp.status_code == 200, resp.text

    resp = requests.get(f"{BASE}/api/recordings/{rid}/rttm", headers=HEADERS, timeout=30)
    lines = [l for l in resp.text.strip().splitlines() if l.startswith("SPEAKER")]
    overlapping = [l for l in lines if " 2.200 3.000 " in l]
    print(f"\nRTTM ({len(lines)} turns); overlapping pair around 2.200/3.000:")
    for l in overlapping:
        print("  " + l)
    if len(overlapping) == 2:
        print("OK: multi-speaker overlap exported as two turns over one window.")
    else:
        print("CHECK: expected 2 overlapping turns.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
