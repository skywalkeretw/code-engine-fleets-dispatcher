# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:26-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY . .

# NEXT_PUBLIC_* values are baked into the browser bundle at build time, so they must
# be supplied here (docker build --build-arg NEXT_PUBLIC_MAX_UPLOAD_RETRIES=5 ...),
# not at `docker run` time. Empty = use the built-in default.
ARG NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS=""
ARG NEXT_PUBLIC_MAX_UPLOAD_RETRIES=""
ARG NEXT_PUBLIC_UPLOAD_TIMEOUT_MS=""
ENV NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS=$NEXT_PUBLIC_MAX_CONCURRENT_UPLOADS \
    NEXT_PUBLIC_MAX_UPLOAD_RETRIES=$NEXT_PUBLIC_MAX_UPLOAD_RETRIES \
    NEXT_PUBLIC_UPLOAD_TIMEOUT_MS=$NEXT_PUBLIC_UPLOAD_TIMEOUT_MS

# Build the Next.js standalone output
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:26-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# Non-root user (uid/gid 1001 — node:26-alpine has 'node' at 1000)
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs --shell /bin/sh nextjs

# Copy the standalone output + static assets
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public           ./public

USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]
