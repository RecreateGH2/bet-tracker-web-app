# Microsoft's Playwright Python image: Chromium + system deps preinstalled.
# Pinned to match playwright>=1.44 in requirements.txt.
FROM mcr.microsoft.com/playwright/python:v1.50.0-jammy

WORKDIR /app

# Install Python deps first for Docker layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app code
COPY backend ./backend

# SQLite + sources.json + horse.rtf live here at runtime
RUN mkdir -p /app/data /app/backend/data

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
