"""Run the DiariZen speaker-diarization example on CPU.

Usage:
    python run_example_cpu.py [wav_path]

By default it loads the checkpoint from the local ``models/`` directory (populated
by ``download_models.py`` or by curl), which avoids going through the HuggingFace
hub at inference time. Pass --hub to download from HuggingFace instead.
"""

import argparse
import time
from pathlib import Path

import torch


HERE = Path(__file__).parent.resolve()
LOCAL_HUB = HERE / "models" / "diarizen-wavlm-large-s80-md"
# NOTE: the directory name must contain "pyannote". pyannote's PretrainedSpeakerEmbedding
# dispatches on substrings of the path and checks "pyannote" before "wespeaker"; a path
# matching only "wespeaker" is sent to the ONNX loader, which cannot read these weights.
LOCAL_EMBED = HERE / "models" / "pyannote-wespeaker-voxceleb-resnet34-LM" / "pytorch_model.bin"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "wav",
        nargs="?",
        default=str(HERE / "example" / "EN2002a_30s.wav"),
        help="input wav file",
    )
    parser.add_argument(
        "--hub",
        action="store_true",
        help="pull the model from HuggingFace instead of the local models/ dir",
    )
    parser.add_argument(
        "--repo-id",
        default="BUT-FIT/diarizen-wavlm-large-s80-md",
        help="HuggingFace repo id, used with --hub",
    )
    parser.add_argument(
        "--rttm-dir",
        default=str(HERE / "example"),
        help="directory to write the RTTM result into",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=0,
        help="torch CPU threads (0 = leave PyTorch's default)",
    )
    args = parser.parse_args()

    if args.threads > 0:
        torch.set_num_threads(args.threads)

    print(f"torch {torch.__version__} | cuda available: {torch.cuda.is_available()}")
    print(f"CPU threads: {torch.get_num_threads()}")

    # Imported late so the banner above still prints if the import chain is broken.
    from diarizen.pipelines.inference import DiariZenPipeline

    sess_name = Path(args.wav).stem.split(".")[0]

    t0 = time.perf_counter()
    if args.hub:
        print(f"loading {args.repo_id} from HuggingFace ...")
        pipeline = DiariZenPipeline.from_pretrained(args.repo_id, rttm_out_dir=args.rttm_dir)
    else:
        if not (LOCAL_HUB / "pytorch_model.bin").exists():
            raise SystemExit(
                f"local checkpoint missing: {LOCAL_HUB / 'pytorch_model.bin'}\n"
                f"run download_models.py first, or pass --hub"
            )
        print(f"loading local checkpoint from {LOCAL_HUB}")
        pipeline = DiariZenPipeline(
            diarizen_hub=LOCAL_HUB,
            embedding_model=str(LOCAL_EMBED),
            rttm_out_dir=args.rttm_dir,
        )
    t1 = time.perf_counter()
    print(f"\n[timing] model load: {t1 - t0:.1f}s")

    results = pipeline(args.wav, sess_name=sess_name)
    t2 = time.perf_counter()

    print("\n--- diarization ---")
    total = 0.0
    speakers = set()
    for turn, _, speaker in results.itertracks(yield_label=True):
        print(f"start={turn.start:6.1f}s stop={turn.end:6.1f}s speaker_{speaker}")
        total += turn.end - turn.start
        speakers.add(speaker)

    print(f"\nspeakers: {len(speakers)} | speech: {total:.1f}s")
    print(f"[timing] inference: {t2 - t1:.1f}s | total: {t2 - t0:.1f}s")
    print(f"RTTM written to: {Path(args.rttm_dir) / (sess_name + '.rttm')}")


if __name__ == "__main__":
    main()
