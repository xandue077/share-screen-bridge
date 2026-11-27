FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    python3 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install

COPY . .

ENV HOST=0.0.0.0
ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
