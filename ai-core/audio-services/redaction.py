import subprocess
import psycopg2
from pyannote.audio import Pipeline
from faster_whisper import WhisperModel
from services.embedding import extract_voice_vector, device
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, HasIdCondition, SearchParams
from presidio_analyzer import AnalyzerEngine

qdrant_client = QdrantClient(url="http://localhost:6333")
postgres_conn = psycopg2.connect("dbname=consent_db user=admin password=secret host=localhost")

diarization_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token="HF_TOKEN").to(device)
whisper_model = WhisperModel("small", device=device, compute_type="float16")
pii_analyzer = AnalyzerEngine()

def check_consent_matrix(user_id: str, project_id: str) -> tuple[bool, bool]:
    """Queries relational DB state to check both biometric and PII permission matrix."""
    with postgres_conn.cursor() as cursor:
        cursor.execute(
            "SELECT biometric_matching, pii_processing FROM project_consent_matrix WHERE master_user_id = %s AND project_id = %s;",
            (user_id, project_id)
        )
        result = cursor.fetchone()
        return result if result else (False, False)

def process_and_redact_audio(audio_path: str, output_path: str, project_id: str, pre_registered_muids: list[str]):
    
    diarization_map = diarization_pipeline(audio_path)
    segments, _ = whisper_model.transcribe(audio_path, word_timestamps=True, vad_filter=True)
    
    
    speaker_best_audio = {}
    for turn, _, speaker_id in diarization_map.itertracks(yield_label=True):
        duration = turn.end - turn.start
        if speaker_id not in speaker_best_audio or duration > speaker_best_audio[speaker_id]["duration"]:
            speaker_best_audio[speaker_id] = {
                "start": turn.start,
                "end": turn.end,
                "duration": duration
            }

   
    speaker_cache = {}
    
    
    scoped_filter = Filter(
        must=[
            HasIdCondition(has_id=pre_registered_muids)
        ]
    )

    for speaker_id, best_clip in speaker_best_audio.items():
        if best_clip["duration"] < 1.5:
            speaker_cache[speaker_id] = {"action": "REDACT_VOICE", "pii_allowed": False}
            continue
            
        try:
            best_embedding = extract_voice_vector(audio_path, start_sec=best_clip["start"], end_sec=best_clip["end"])
            
            search_res = qdrant_client.search(
                collection_name="user_voice_embeddings", 
                query_vector=best_embedding, 
                query_filter=scoped_filter,       
                search_params=SearchParams(hnsw_ef=64),
                limit=1
            )
            
            if search_res and search_res[0].score >= 0.75: 
                matched_uid = search_res[0].payload["master_user_id"]
                bio_consent, pii_consent = check_consent_matrix(matched_uid, project_id)
                
                speaker_cache[speaker_id] = {
                    "action": "KEEP" if bio_consent else "REDACT_VOICE",
                    "pii_allowed": pii_consent
                }
            else:
                speaker_cache[speaker_id] = {"action": "REDACT_VOICE", "pii_allowed": False}
        except Exception:
            speaker_cache[speaker_id] = {"action": "REDACT_VOICE", "pii_allowed": False}

    redaction_intervals = []
    
    for turn, _, speaker_id in diarization_map.itertracks(yield_label=True):
        if speaker_cache[speaker_id]["action"] == "REDACT_VOICE":
            redaction_intervals.append({"start": turn.start, "end": turn.end})

    for segment in segments:
        current_speaker = None
        for turn, _, speaker_id in diarization_map.itertracks(yield_label=True):
            if turn.start <= segment.start <= turn.end:
                current_speaker = speaker_id
                break
        
        if current_speaker and not speaker_cache[current_speaker]["pii_allowed"]:
            pii_results = pii_analyzer.analyze(
                text=segment.text, language="en", 
                entities=["PHONE_NUMBER", "EMAIL_ADDRESS", "CREDIT_CARD", "PERSON", "LOCATION"]
            )
            if pii_results:
                for entity in pii_results:
                    for word in segment.words:
                        if (segment.text.find(word.word) >= entity.start) and (segment.text.find(word.word) <= entity.end):
                            redaction_intervals.append({"start": word.start, "end": word.end})

    if not redaction_intervals:
        subprocess.run(["ffmpeg", "-y", "-i", audio_path, "-c", "copy", output_path], stdout=subprocess.DEVNULL)
        return

    filter_expr = ",".join([f"volume=0:enable='between(t,{i['start']},{i['end']})'" for i in redaction_intervals])
    cmd = ["ffmpeg", "-y", "-i", audio_path, "-af", filter_expr, "-c:v", "copy", output_path]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)