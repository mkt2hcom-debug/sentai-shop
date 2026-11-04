FROM node:22.23.4-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git openssh-client python3 python3-venv python-is-python3 \
       ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

USER node
