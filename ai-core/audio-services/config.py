from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):

    ENV: str = Field(default="development", description="Current deployment stage")
    API_V1_STR: str = "/api/v1"
    PROJECT_NAME: str = "Samsung-Prism-Privacy-Audio-Engine"

    DATABASE_URL: str = Field(
        default="postgresql://postgres:secret@localhost:5432/postgres"
    )

    HF_TOKEN: str = Field(default="hf_placeholder_token")

    SIMILARITY_THRESHOLD: float = Field(default=0.10)
    MIN_UTTERANCE_DURATION: float = Field(default=1.5)

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    @property
    def postgres_connection_string(self) -> str:
        """Dynamically computes the raw connection string for psycopg2."""
        return f"dbname={self.DB_NAME} user={self.DB_USER} password={self.DB_PASSWORD} host={self.DB_HOST} port={self.DB_PORT}"


settings = Settings()
