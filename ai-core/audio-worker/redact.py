import subprocess


def apply_mute_intervals(input_path: str, output_path: str, intervals: list[dict]) -> None:
    """Mutes the given [start, end] second ranges in `input_path` and writes
    the result to `output_path`.

    This function knows nothing about *why* an interval was chosen — no
    speaker identity, no consent, no PII type. That decision was already
    made by whoever called /redact (the backend, using /analyze's output
    joined against real consent data). Keeping this pure and dumb is
    deliberate: it is the one piece of the pipeline that must behave
    identically regardless of who's asking or why.
    """
    valid_intervals = [
        i
        for i in intervals
        if isinstance(i, dict)
        and "start" in i
        and "end" in i
        and float(i["end"]) > float(i["start"])
    ]
    if valid_intervals:
        sorted_intervals = sorted(valid_intervals, key=lambda x: float(x["start"]))
        filter_expr = ",".join(
            f"volume=0:enable='between(t,{i['start']},{i['end']})'" for i in sorted_intervals
        )
        cmd = ["ffmpeg", "-y", "-i", input_path, "-af", filter_expr, output_path]
    else:
        cmd = ["ffmpeg", "-y", "-i", input_path, output_path]

    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='replace')}")
