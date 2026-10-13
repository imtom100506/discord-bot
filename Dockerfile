FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng ffmpeg bzip2 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY models ./models
COPY scripts ./scripts
RUN node scripts/download-models.js
USER node
CMD ["node", "src/index.js"]
