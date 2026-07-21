FROM python:3.10-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# Force insightface model download directory
ENV INSIGHTFACE_HOME=/root/.insightface

# Set work directory
WORKDIR /app

# Install system dependencies required by OpenCV and InsightFace
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    build-essential \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Pre-download the InsightFace model weights to prevent hanging on first API call
RUN mkdir -p /root/.insightface/models/buffalo_l && \
    wget -q https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip -O /tmp/buffalo_l.zip && \
    unzip -q /tmp/buffalo_l.zip -d /root/.insightface/models/buffalo_l && \
    rm /tmp/buffalo_l.zip

# Copy the entire project first (needed for setuptools to find app/ package)
COPY . /app

# Install python dependencies
RUN pip install --upgrade pip
RUN pip install .

# Expose the port FastAPI runs on
EXPOSE 8000

# Command to run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
