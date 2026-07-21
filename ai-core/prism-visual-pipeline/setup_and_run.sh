#!/bin/bash
set -e

# PRISM Visual Pipeline Demo Setup and Launcher
# This script sets up a local virtual environment, installs dependencies, and runs the FastAPI backend.

echo "=========================================================="
echo "   PRISM Visual Pipeline — Demo Environment Setup"
echo "=========================================================="

# Check Python version
python3 --version || { echo "Error: Python 3 is required but not installed."; exit 1; }

# Navigate to the script directory
cd "$(dirname "$0")"

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment 'venv'..."
    python3 -m venv venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Install dependencies
echo "Upgrading pip..."
pip install --upgrade pip

echo "Installing project dependencies (this may take a minute or two)..."
# We install directly from pyproject.toml
pip install -e .

echo "Checking installation..."
python3 -c "
import insightface
import qdrant_client
import fastapi
import uvicorn
print('✅ All packages successfully imported!')
" || { echo "Error: Dependency installation check failed."; exit 1; }

echo "----------------------------------------------------------"
echo "🎉 Setup complete!"
echo "----------------------------------------------------------"
echo "To run the backend server:"
echo "  1. The server will use in-memory Qdrant (no Docker required!) because PRISM_QDRANT_HOST=:memory: is set in .env."
echo "  2. Starting FastAPI server now on http://localhost:8000..."
echo "  3. Open 'demo.html' in your browser to view the interactive demo dashboard!"
echo "----------------------------------------------------------"

# Run the FastAPI backend
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
