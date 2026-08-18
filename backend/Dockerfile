FROM node:22-bookworm-slim

# openssl: the Prisma query engine links against it and fails at runtime
# without it, not at build time.
# build-essential + python3: bcrypt and sharp both ship arm64 prebuilds today,
# but node-pre-gyp falls back to a source build the moment one is missing for
# a version — cheaper to carry the toolchain than to debug that on the server.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
# schema.prisma pins no binaryTargets, so the engine generated here is for the
# build host's architecture only. Build this image ON the ARM instance — an
# amd64 image shipped to Ampere will fail at first query, not at boot.
RUN npx prisma generate

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 4000

# Overridden per-service in compose for the four workers.
CMD ["node", "src/server.js"]
