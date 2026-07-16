import os
import shutil
import uuid
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles 
import json
import uvicorn

from config import settings
from redaction import process_and_redact_session

app = FastAPI(
    title=f"{settings.PROJECT_NAME} - Local Testing",
    version="1.0.0",
    docs_url=f"{settings.API_V1_STR}/docs",
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
)

LOCAL_OUTPUT_DIR = os.path.abspath("./test_outputs")
os.makedirs(LOCAL_OUTPUT_DIR, exist_ok=True)

app.mount("/static-audio", StaticFiles(directory=LOCAL_OUTPUT_DIR), name="static-audio")


@app.post(f"{settings.API_V1_STR}/sessions/redact")
async def redact_audio_session_test(
    project_id: str = Form(...),
    participant_mapping: str = Form(...),
    main_audio: UploadFile = File(...),
    snippets: list[UploadFile] = File(...),
):
    """Local testing endpoint that preserves audio files on disk for review."""
    session_id = str(uuid.uuid4())
    session_working_dir = os.path.join(LOCAL_OUTPUT_DIR, session_id)
    os.makedirs(session_working_dir, exist_ok=True)

    try:
        try:
            participant_mapping = json.loads(participant_mapping)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON in participant_mapping")
    
        main_audio_ext = os.path.splitext(main_audio.filename)[1] or ".wav"
        input_audio_path = os.path.join(
            session_working_dir, f"input_main{main_audio_ext}"
        )
        with open(input_audio_path, "wb") as buffer:
            shutil.copyfileobj(main_audio.file, buffer)

        uploaded_file_map = {f.filename: f for f in snippets}
        resolved_snippet_paths = {}

        for muid, filename in participant_mapping.items():
            if filename not in uploaded_file_map:
                raise HTTPException(status_code=400, detail=f"Missing file: {filename}")

            target_file = uploaded_file_map[filename]
            snippet_ext = os.path.splitext(target_file.filename)[1] or ".wav"
            snippet_disk_path = os.path.join(
                session_working_dir, f"snippet_{muid}{snippet_ext}"
            )

            with open(snippet_disk_path, "wb") as buffer:
                shutil.copyfileobj(target_file.file, buffer)
            resolved_snippet_paths[muid] = snippet_disk_path

        output_filename = f"redacted_output{main_audio_ext}"
        output_audio_path = os.path.join(session_working_dir, output_filename)

        pipeline_result = process_and_redact_session(
            audio_path=input_audio_path,
            participant_snippets=resolved_snippet_paths,
            output_path=output_audio_path,
            project_id=project_id,
        )

        listen_url = (
            f"http://localhost:8000/static-audio/{session_id}/{output_filename}"
        )

        return {
            "status": "SUCCESS",
            "session_id": session_id,
            "session_metadata": pipeline_result["session_metadata"],
            "listen_url": listen_url,
            "local_disk_path": output_audio_path,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Pipeline Error: {str(e)}")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
