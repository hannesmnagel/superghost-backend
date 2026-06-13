FROM node:22-slim AS build
WORKDIR /app

# Install openssl for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx tsc --project tsconfig.json

# Build word lists (downloaded at build time, baked into image)
RUN npx tsx scripts/build-wordlists.ts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package files and prisma schema first so postinstall can run
COPY package*.json ./
COPY prisma ./prisma

# Install prod deps (postinstall = prisma generate, needs schema present)
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
COPY Public ./Public

EXPOSE 8080

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
