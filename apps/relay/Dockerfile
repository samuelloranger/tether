# The relay is deliberately its own image with its own lifecycle. It is the
# only public-facing piece of Tether infrastructure, and it must never share a
# host, a process, or a network namespace with an actual Tether server — a
# Tether daemon is a shell on the machine it runs on.
FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN bun install --production --no-save

FROM oven/bun:1.4.0-alpine
WORKDIR /app

# Runs unprivileged. The only secret it touches is the APNs key, mounted
# read-only at runtime and never baked into the image.
RUN addgroup -S relay && adduser -S relay -G relay
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER relay

ENV PORT=8090
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8090/health || exit 1

CMD ["bun", "run", "src/index.ts"]
