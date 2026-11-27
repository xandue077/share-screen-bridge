FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    python3 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install \
  && mkdir -p /app/bin \
  && cp "$(node -p "require('@ffmpeg-installer/ffmpeg').path")" /app/bin/ffmpeg \
  && cp "$(node -p "require('@ffprobe-installer/ffprobe').path")" /app/bin/ffprobe \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /app/bin/yt-dlp \
  && chmod +x /app/bin/ffmpeg /app/bin/ffprobe /app/bin/yt-dlp

COPY . .

ENV HOST=0.0.0.0
ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
