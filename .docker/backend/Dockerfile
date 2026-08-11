# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      libcairo2-dev \
      libgif-dev \
      libjpeg-dev \
      libpango1.0-dev \
      librsvg2-dev \
      make \
      pkg-config \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      fontconfig \
      libcairo2 \
      libgif7 \
      libjpeg62-turbo \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY backend/ ./

EXPOSE 5000

CMD ["npm", "start"]
