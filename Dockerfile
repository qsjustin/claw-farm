FROM oven/bun:1.3.13 AS deps
WORKDIR /app
COPY package.json ./
RUN bun install

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY scripts scripts
COPY src src
RUN bun run typecheck

FROM oven/bun:1.3.13 AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io tar zstd ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json ./
ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["--help"]
