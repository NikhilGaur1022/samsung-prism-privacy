import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

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


def test_apply_mute_intervals_no_intervals_just_copies(tmp_path):
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
    assert "-c" in called_cmd


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
