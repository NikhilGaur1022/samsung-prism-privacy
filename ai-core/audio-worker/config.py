from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    """Deliberately holds no database credentials.

    This worker is stateless: it never queries Postgres and never makes a
    consent decision. Consent lookups and the KEEP/REDACT decision belong to
    the backend, which calls /analyze, joins the result against the real
    `project_consent_matrix`, and then calls /redact with the final interval
    list. Matches the shape of face-worker and image-pii-worker, neither of
    which talk to a database either.
    """

    ENV: str = Field(default="development", description="Current deployment stage")
    API_V1_STR: str = "/api/v1"
    PROJECT_NAME: str = "Samsung-Prism-Privacy-Audio-Worker"

    HF_TOKEN: str = Field(
        default="",
        description="Required to pull the gated pyannote/speaker-diarization-3.1 model",
    )
    WHISPER_MODEL_SIZE: str = Field(default="small")
    # SIMILARITY_THRESHOLD used to live here. It is gone rather than left unused:
    # identity matching moved to the backend (VOICE_MATCH_THRESHOLD in
    # backend/.env.example), and a knob that still reads from the environment but
    # no longer changes who gets identified is worse than no knob — someone tunes
    # it, sees no effect, and concludes the matching is broken.
    MIN_UTTERANCE_DURATION: float = Field(default=1.5)
    MIN_SPEAKERS: int | None = Field(default=None)
    MAX_SPEAKERS: int | None = Field(default=None)

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )


settings = Settings()
