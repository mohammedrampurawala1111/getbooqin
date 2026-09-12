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
# Migrations have moved OUT of this CMD and into fly.toml's
# release_command — see the comment there. Running them here meant a
# failed migration crash-looped the machine instead of aborting the
# deploy, which stopped being acceptable once a migration could
# legitimately refuse to apply (Phase 0's B2 exclusion constraints).
#
# The backfills stay: both are idempotent and cheap, and unlike a
# migration neither has a failure mode worth aborting a deploy over.
# scripts_backfill_terms.ts is Phase 1's — it writes each shop's
# vocabulary at rest now that nothing derives it from a preset id (see
# core/src/booking/presets.ts). It's a no-op once every row is caught up,
# and can be dropped from this line after one successful deploy.
#
# scripts_backfill_subscriptions.ts is Phase 2a's, and its position here
# matters more than the others': a Connection with no Subscription row
# resolves to the **Free** plan (see billing/entitlements.ts), so between
# the new code starting and that row existing, an established merchant
# would be capped at 1 resource and 50 bookings. Running it in the CMD,
# before `npm run start`, closes that window entirely — the server does
# not accept a request until every account has its row.
CMD ["sh", "-c", "npx tsx core/scripts_backfill_resource_assignments.ts && npx tsx core/scripts_backfill_terms.ts && npx tsx core/scripts_backfill_subscriptions.ts && npm run start -w server"]
