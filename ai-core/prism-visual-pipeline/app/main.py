"""
PRISM Visual Pipeline — FastAPI Application Entry Point.

Configures CORS, registers API routers, and exposes the health-check endpoint.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.config import settings

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan — log configuration on startup."""
    logger.info("PRISM Visual Pipeline starting up...")
    logger.info("  Qdrant:          %s:%s", settings.QDRANT_HOST, settings.QDRANT_PORT)
    logger.info("  Match threshold: %.2f", settings.MATCH_THRESHOLD)
    logger.info("  Min det conf:    %.2f", settings.MIN_DET_CONFIDENCE)
    logger.info("  Staging dir:     %s", settings.STAGING_DIR)
    logger.info("  Model:           %s", settings.INSIGHTFACE_MODEL)
    yield


app = FastAPI(
    title="PRISM Visual Pipeline",
    description="Face detection, consent-aware tagging, and surgical redaction engine",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow all origins for demo
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
from app.api.enrollment import router as enrollment_router
from app.api.upload import router as upload_router

app.include_router(enrollment_router)
app.include_router(upload_router)


@app.get("/health")
async def health_check():
    """Health check endpoint for monitoring and connectivity testing."""
    from app.services.qdrant_session import SessionQdrantManager

    qdrant_status = "connected"
    try:
        client = SessionQdrantManager._get_client()
        # Quick connectivity check
        if settings.QDRANT_HOST != ":memory:":
            client.get_collections()
    except Exception as e:
        qdrant_status = f"error: {e}"

    return {
        "status": "healthy",
        "qdrant": qdrant_status,
        "config": {
            "qdrant_host": settings.QDRANT_HOST,
            "qdrant_port": settings.QDRANT_PORT,
            "match_threshold": settings.MATCH_THRESHOLD,
            "model": settings.INSIGHTFACE_MODEL,
        },
    }


# Serve demo.html at root if it exists
_demo_path = Path(__file__).parent.parent / "demo.html"


@app.get("/")
async def serve_demo():
    """Serve the demo dashboard HTML file."""
    if _demo_path.exists():
        return FileResponse(_demo_path, media_type="text/html")
    return {"message": "PRISM Visual Pipeline API. See /docs for endpoints."}
