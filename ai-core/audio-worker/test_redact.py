import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

cur_dir = Path(__file__).resolve().parent
if str(cur_dir) not in sys.path:
    sys.path.insert(0, str(cur_dir))

from main import _map_pii_span_to_time, _speaker_for_segment  # noqa: E402
from redact import apply_mute_intervals  # noqa: E402


def test_apply_mute_intervals_builds_filter_expr(tmp_path):
    input_path = tmp_path / "in.wav"
    output_path = tmp_path / "out.wav"
    input_path.write_bytes(b"fake-audio-bytes")

    with patch("redact.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=b"", stderr=b""
        )
        apply_mute_intervals(str(input_path), str(output_path), [{"start": 1.0, "end": 2.5}])

    called_cmd = mock_run.call_args[0][0]
    assert "-af" in called_cmd
    filter_arg = called_cmd[called_cmd.index("-af") + 1]
    assert "between(t,1.0,2.5)" in filter_arg


def test_apply_mute_intervals_sorts_multiple_intervals(tmp_path):
    input_path = tmp_path / "in.wav"
    output_path = tmp_path / "out.wav"
    input_path.write_bytes(b"fake-audio-bytes")

    with patch("redact.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=b"", stderr=b""
        )
        apply_mute_intervals(
            str(input_path),
            str(output_path),
            [{"start": 5.0, "end": 6.0}, {"start": 1.0, "end": 2.0}],
        )

    called_cmd = mock_run.call_args[0][0]
    assert "-af" in called_cmd
    filter_arg = called_cmd[called_cmd.index("-af") + 1]
    assert filter_arg == "volume=0:enable='between(t,1.0,2.0)',volume=0:enable='between(t,5.0,6.0)'"


def test_apply_mute_intervals_no_intervals_runs_ffmpeg(tmp_path):
    input_path = tmp_path / "in.wav"
    output_path = tmp_path / "out.wav"
    input_path.write_bytes(b"fake-audio-bytes")

    with patch("redact.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=b"", stderr=b""
        )
        apply_mute_intervals(str(input_path), str(output_path), [])

    called_cmd = mock_run.call_args[0][0]
    assert "-af" not in called_cmd
    assert output_path.name in str(called_cmd[-1])


def test_apply_mute_intervals_raises_on_ffmpeg_failure(tmp_path):
    input_path = tmp_path / "in.wav"
    output_path = tmp_path / "out.wav"
    input_path.write_bytes(b"fake-audio-bytes")

    with patch("redact.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=1, stdout=b"", stderr=b"boom"
        )
        try:
            apply_mute_intervals(str(input_path), str(output_path), [])
            assert False, "expected RuntimeError"
        except RuntimeError as exc:
            assert "boom" in str(exc)


def test_speaker_for_segment_maximum_overlap():
    turns = [
        {"start": 0.0, "end": 2.0, "speaker_id": "SPEAKER_00"},
        {"start": 2.0, "end": 6.0, "speaker_id": "SPEAKER_01"},
    ]
    speaker = _speaker_for_segment(turns, 1.5, 3.0)
    assert speaker == "SPEAKER_01"


def test_speaker_for_segment_gap_fallback():
    turns = [
        {"start": 0.0, "end": 1.0, "speaker_id": "SPEAKER_00"},
        {"start": 3.0, "end": 4.0, "speaker_id": "SPEAKER_01"},
    ]
    speaker = _speaker_for_segment(turns, 1.2, 1.8)
    assert speaker == "SPEAKER_00"


def test_speaker_for_segment_empty_turns():
    speaker = _speaker_for_segment([], 0.0, 1.0)
    assert speaker is None


def test_map_pii_span_to_time_exact_word_mapping():
    words = [
        SimpleNamespace(word=" My", start=0.0, end=0.4),
        SimpleNamespace(word=" phone", start=0.5, end=0.9),
        SimpleNamespace(word=" is", start=1.0, end=1.2),
        SimpleNamespace(word=" 9876543210", start=1.3, end=2.5),
        SimpleNamespace(word=" thank", start=2.8, end=3.1),
        SimpleNamespace(word=" you", start=3.2, end=3.5),
    ]
    seg = SimpleNamespace(
        text="My phone is 9876543210 thank you",
        start=0.0,
        end=3.5,
        words=words,
    )
    span = {"type": "PHONE_NUMBER", "start": 12, "end": 22}
    start_t, end_t = _map_pii_span_to_time(seg, span)
    assert start_t == 1.3
    assert end_t == 2.5


def test_map_pii_span_to_time_fallback_when_no_words():
    seg = SimpleNamespace(
        text="My phone is 9876543210 thank you",
        start=0.0,
        end=3.5,
        words=None,
    )
    span = {"type": "PHONE_NUMBER", "start": 12, "end": 22}
    start_t, end_t = _map_pii_span_to_time(seg, span)
    assert start_t == 0.0
    assert end_t == 3.5
