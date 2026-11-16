# VBrowse container: Node 22 + ffmpeg (used to scan video frames for NSFW content)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

ENV NODE_ENV=production \
    PORT=10000 \
    DB_PATH=/data/vbrowse.db \
    UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads
EXPOSE 10000
CMD ["node", "--no-warnings", "server.js"]
