FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
ENV PORT=3000
COPY --from=build /app/build ./build
COPY server.ts ./
EXPOSE 3000
USER bun
CMD ["bun", "run", "server.ts"]
