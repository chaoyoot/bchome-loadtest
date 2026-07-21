FROM mcr.microsoft.com/playwright:v1.61.1-jammy

# Add audio generation tools and virtual display.
# Everything else (Node.js, Chromium, system deps) is already in the base image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    ffmpeg \
    xvfb \
    && rm -rf /var/lib/apt/lists/*
