import subprocess
import numpy as np
from pyannote.audio import Pipeline
from faster_whisper import WhisperModel
from config import settings
import torch
import torchaudio
from speechbrain.inference.speaker import SpeakerRecognition
from presidio import get_pii_analyzer
device = "cuda" if torch.cuda.is_available() else "cpu"

_speaker_embedding_model = None

def get_speaker_embedding_model():
    global _speaker_embedding_model
    if _speaker_embedding_model is None:
        print("Loading speaker embedding model...")
        _speaker_embedding_model = SpeakerRecognition.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir="/tmp/models/spkrec-ecapa",
            run_opts={"device": device},
        )
    return _speaker_embedding_model


def extract_voice_vector(
    audio_path: str, start_sec: float = None, end_sec: float = None
) -> list[float]:
    """Extract speaker embedding using SpeechBrain ECAPA-TDNN."""
    waveform, sr = torchaudio.load(audio_path)
    if sr != 16000:
        resampler = torchaudio.transforms.Resample(sr, 16000)
        waveform = resampler(waveform)

    if start_sec is not None and end_sec is not None:
        start_sample = int(start_sec * 16000)
        end_sample = int(end_sec * 16000)
        waveform = waveform[:, start_sample:end_sample]

    with torch.no_grad():
        embedding = get_speaker_embedding_model().encode_batch(waveform)

    return embedding[0][0].cpu().numpy().tolist()


diarization_pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1", token=settings.HF_TOKEN
).to(torch.device(device))
compute_target = "float16" if device == "cuda" else "float32"
whisper_model = WhisperModel("small", device=device, compute_type=compute_target)


def fetch_batch_consent_profiles(muid_list: list[str], project_id: str) -> dict:
    """Queries relational DB state to pull exact consent settings for all session users."""
    # profiles = {}
    # if not muid_list:
    #     return profiles

    # with postgres_conn.cursor() as cursor:
    #     cursor.execute(
    #         """SELECT master_user_id, "generalTerms", "biometricMatch", "piiProcessing"
    #         FROM data_subjects
    #         WHERE master_user_id = ANY(%s::uuid[]);""",
    #         (muid_list, project_id),
    #     )
    #     for row in cursor.fetchall():
    #         profiles[row[0]] = {
    #             "general_allowed": row[1],
    #             "biometric_allowed": row[2],
    #             "pii_allowed": row[3],
    #         }
    profiles = {
        "bob": {
            "general_allowed": True,  
            "biometric_allowed": False,  
            "pii_allowed": False,  
        },
        "alice": {
            "general_allowed": True,  
            "biometric_allowed": True,  
            "pii_allowed": False,  
        },
    }

    return profiles


def compute_cosine_similarity(vecA: list[float], vecB: list[float]) -> float:
    """Computes direct 1:1 similarity between two voice vectors in memory."""
    a = np.array(vecA)
    b = np.array(vecB)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def process_and_redact_session(
    audio_path: str,
    participant_snippets: dict[str, str],
    output_path: str,
    project_id: str,
) -> dict:
    """
    Processes session audio by matching local snippets, enforcing batch consent rules,
    and returning structural tracking metadata.
    """

    diarization = diarization_pipeline(audio_path)

    segments, _ = whisper_model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=False,
        vad_parameters=dict(
            min_silence_duration_ms=500, 
            speech_pad_ms=400, 
        ),
    )
    segments = list(segments) 
    print(f"DEBUG: vad_filter=False, total segments transcribed: {len(segments)}")
    for s in segments:
        print(f"DEBUG SEGMENT: [{s.start:.2f}-{s.end:.2f}] {s.text!r}")
    registered_vectors = {}
    for muid, snippet_path in participant_snippets.items():
        try:
            registered_vectors[muid] = extract_voice_vector(snippet_path)
        except Exception:
            continue

    room_consent_registry = fetch_batch_consent_profiles(
        list(participant_snippets.keys()), project_id
    )

    speaker_best_audio = {}
    for segment, track, speaker_id in diarization.speaker_diarization.itertracks(
        yield_label=True
    ):

        duration = segment.end - segment.start
        if (
            speaker_id not in speaker_best_audio
            or duration > speaker_best_audio[speaker_id]["duration"]
        ):
            speaker_best_audio[speaker_id] = {
                "start": segment.start,
                "end": segment.end,
                "duration": duration,
            }

    speaker_identity_map = {}
    speaker_cache = {}

    for speaker_id, best_clip in speaker_best_audio.items():
        if best_clip["duration"] < 1.5:
            print(
                f"DEBUG: Speaker {speaker_id} too short ({best_clip['duration']:.2f}s), skipping"
            )
            speaker_cache[speaker_id] = {"action": "REDACT_VOICE", "pii_allowed": False}
            speaker_identity_map[speaker_id] = "UNKNOWN_BYSTANDER"
            continue

        try:
            print(
                f"\nDEBUG: Matching speaker {speaker_id} (duration={best_clip['duration']:.2f}s)"
            )
            current_embedding = extract_voice_vector(
                audio_path, start_sec=best_clip["start"], end_sec=best_clip["end"]
            )
            print(
                f"DEBUG: Extracted embedding shape={np.array(current_embedding).shape}"
            )

            best_match_muid = None
            highest_score = 0.0

            for muid, target_vector in registered_vectors.items():
                score = compute_cosine_similarity(target_vector, current_embedding)
                print(f"DEBUG:   vs {muid}: score={score:.4f}")  # ← THIS IS KEY
                if score > highest_score:
                    highest_score = score
                    best_match_muid = muid

            print(
                f"DEBUG: Best match: {best_match_muid} (score={highest_score:.4f}), threshold={settings.SIMILARITY_THRESHOLD}"
            )

            if best_match_muid and highest_score >= settings.SIMILARITY_THRESHOLD:
                speaker_identity_map[speaker_id] = best_match_muid
                profile = room_consent_registry.get(
                    best_match_muid,
                    {
                        "general_allowed": False,
                        "biometric_allowed": False,
                        "pii_allowed": False,
                    },
                )

                is_authorized = (
                    profile["general_allowed"] and profile["biometric_allowed"]
                )
                speaker_cache[speaker_id] = {
                    "action": "KEEP" if is_authorized else "REDACT_VOICE",
                    "pii_allowed": profile["pii_allowed"],
                }
            else:
                speaker_identity_map[speaker_id] = "UNKNOWN_BYSTANDER"
                speaker_cache[speaker_id] = {
                    "action": "REDACT_VOICE",
                    "pii_allowed": False,
                }

        except Exception:
            speaker_cache[speaker_id] = {"action": "REDACT_VOICE", "pii_allowed": False}
            speaker_identity_map[speaker_id] = "UNKNOWN_BYSTANDER"

    redaction_intervals = []
    metadata_timestamps = []

    for segment, track, speaker_id in diarization.speaker_diarization.itertracks(
        yield_label=True
    ):
        assigned_muid = speaker_identity_map.get(speaker_id, "UNKNOWN_BYSTANDER")

        metadata_timestamps.append(
            {
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "master_user_id": assigned_muid,
            }
        )

        if speaker_cache.get(speaker_id, {}).get("action") == "REDACT_VOICE":
            redaction_intervals.append({"start": segment.start, "end": segment.end})
    
    # Presidio Text PII Redaction Filter
    for segment in segments:
        current_speaker = None
        best_overlap = 0.0
        for portion, track, speaker_id in diarization.speaker_diarization.itertracks(yield_label=True):
            overlap_start = max(portion.start, segment.start)
            overlap_end = min(portion.end, segment.end)
            overlap = max(0.0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                current_speaker = speaker_id
        print(f"DEBUG: segment[{segment.start:.2f}-{segment.end:.2f}] -> current_speaker={current_speaker}, pii_allowed={speaker_cache.get(current_speaker, {}).get('pii_allowed') if current_speaker else 'N/A'}")
        if current_speaker and not speaker_cache.get(current_speaker, {}).get(
            "pii_allowed", False
        ):
            pii_analyzer = get_pii_analyzer()
            pii_results = pii_analyzer.analyze(
                text=segment.text,
                language="en",
                entities=[
                    "PHONE_NUMBER",
                    "EMAIL_ADDRESS",
                    "CREDIT_CARD",
                    "PERSON",
                    "LOCATION",
                    "DATE_TIME",
                    "NRP",
                    "STREET_ADDRESS",
                ],
            )
            print(f"DEBUG: Text: {segment.text!r}")
            print(f"DEBUG: PII results: {pii_results}")
            if pii_results:
                for entity in pii_results:
                    for word in segment.words:
                        if hasattr(word, "start_char") and hasattr(word, "end_char"):
                            if not (
                                word.end_char <= entity.start
                                or word.start_char >= entity.end
                            ):
                                redaction_intervals.append(
                                    {"start": word.start, "end": word.end}
                                )
                        else:

                            word_pos = segment.text.find(word.word)
                            if word_pos != -1 and not (
                                word_pos + len(word.word) <= entity.start
                                or word_pos >= entity.end
                            ):
                                redaction_intervals.append(
                                    {"start": word.start, "end": word.end}
                                )
    print(f"DEBUG: Detected speakers: {list(speaker_best_audio.keys())}")
    print(f"DEBUG: Registered vectors keys: {list(registered_vectors.keys())}")
    print(f"DEBUG: SIMILARITY_THRESHOLD: {settings.SIMILARITY_THRESHOLD}")
    if redaction_intervals:
        filter_expr = ",".join(
            [
                f"volume=0:enable='between(t,{i['start']},{i['end']})'"
                for i in redaction_intervals
            ]
        )
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            audio_path,
            "-af",
            filter_expr,
            "-c:v",
            "copy",
            output_path,
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.run(
            ["ffmpeg", "-y", "-i", audio_path, "-c", "copy", output_path],
            stdout=subprocess.DEVNULL,
        )

    return {"output_file_path": output_path, "session_metadata": metadata_timestamps}
