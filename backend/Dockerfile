# ---- Build stage: installs dev headers so `canvas` (native bindings, used
# for Bluetooth bill printing) can compile against cairo/pango/jpeg/gif/rsvg ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# ---- Runtime stage: only the shared libs `canvas` links against at runtime,
# plus Vietnamese-capable fonts (see fonts/README.md) — no compilers/headers ----
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    fontconfig fonts-dejavu-core fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "server.js"]
