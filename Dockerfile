# Builds and runs the whole getbooqin-workspace monorepo as one image:
# core (shared lib) + cloud + shopify-openslot, served by server/combined.js
# on one Fly app/process. Build context must be the repo root (this file's
# own directory) so the "getbooqin-core" workspace dependency resolves.
FROM node:20-slim

WORKDIR /repo

# Prisma's query engine needs OpenSSL on Debian-based images.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Install with only the workspace manifests first, so `npm ci` is cached
# across builds that only change source, not dependencies.
COPY package.json package-lock.json ./
COPY core/package.json core/package.json
COPY cloud/package.json cloud/package.json
COPY shopify-openslot/package.json shopify-openslot/package.json
COPY server/package.json server/package.json
RUN npm ci

COPY core core
COPY cloud cloud
COPY shopify-openslot shopify-openslot
COPY server server

# Clerk's publishable key gets compiled into cloud's client JS bundle by
# Vite at build time (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) — unlike
# every other secret here, it can't just be a `fly secrets set` runtime
# value, it must be passed at image-build time. Not sensitive (Clerk's
# publishable keys are meant to be public), so a build arg is fine:
#   fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_live_xxx
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY

# Prisma client must exist before core's tsc build — core's own source
# imports generated model types (Booking, ServiceConfig, ...) from it.
RUN npx prisma generate --schema core/prisma/schema.prisma
# core next — cloud and shopify-openslot both import it as a built
# workspace package (dist/*.js), not from source.
RUN npm run build -w core
RUN npm run build -w cloud
RUN npm run build -w shopify-openslot

ENV NODE_ENV=production
EXPOSE 3000
# The resource-assignment backfill (see core/scripts_backfill_resource_assignments.ts)
# runs here, after migrations and before the server starts, because this
# session has no other route to production DB access — it's idempotent and
# cheap, so running it on every boot is harmless.
CMD ["sh", "-c", "npx prisma migrate deploy --schema core/prisma/schema.prisma && npx tsx core/scripts_backfill_resource_assignments.ts && npm run start -w server"]
