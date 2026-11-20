#
# Munaxa Control — one build, three targets:
#
#   api      the control API (default). Production dependencies only, non-root, read-only friendly.
#   migrate  the one-off release job: `prisma migrate deploy` as the owner role, then the runtime grants.
#   portal   the Super Admin portal, Next.js standalone server. Holds no secret.
#
# Reproducible: the base image is pinned by digest, pnpm by version through corepack, and every
# dependency by the committed lockfile (`--frozen-lockfile`). The registry credential for `@munaxa/*`
# (GitHub Packages, read:packages) is a BuildKit secret: it exists for the install step only and is
# never written to a layer.
#
#   docker buildx build --secret id=node_auth_token,env=NODE_AUTH_TOKEN \
#     --target api -t munaxa-control-api:<commit> .
#
# Nothing here holds the licence signing key: with KMS (ADR-0008) it never leaves AWS KMS, and with
# FILE it is mounted at run time (docs/operations/).

# Alpine, the base Munaxa Identity ships (identity apps/api/Dockerfile, identity#20): node:22-alpine
# (Node 22.23.5, Alpine 3.24.4) as published on 11 Nov 2026, with zlib raised to 1.4-r0. Its images
# (identity 2db6ed9) scan with no finding at all in ECR (13 Nov 2026).
#
# Why not Debian any more (report 2026-11-20-rds-rotation-and-docs-first-approvals): the 8 Nov
# images on node:22-bookworm-slim scan with 7 HIGH findings in apt 2.6.1, util-linux
# 2.38.1-5+deb12u3, zlib 1.2.13.dfsg-1 and glibc 2.36-9+deb12u14. The 20 Nov bookworm-slim digest
# (e9f565d3) still ships those util-linux, zlib and glibc versions (only apt moved, to 2.6.2), and
# `apt-get upgrade` on top of it upgraded 0 packages in CI on 20 Nov 2026: Debian had published no
# fix. So a Debian rebuild clears at most 1 of the 7. Alpine has no util-linux and no glibc in the
# image (musl), and zlib is the fixed 1.4-r0.
#
# The zlib version is exact, not `>=`, so the image is reproducible: if Alpine replaces 1.4-r0 the
# build fails here, loudly. .github/scripts/verify-image.sh checks every target in CI.
ARG NODE_IMAGE=node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

# Empty unless a build overrides it (`--build-context vendor=<dir>`) to supply packages that are not
# yet on the registry — only for verifying this file before `@munaxa/licensing` is published.
FROM scratch AS vendor

FROM ${NODE_IMAGE} AS os
# OpenSSL for Prisma's query engine, which otherwise guesses the library version and may not load;
# Prisma generates the linux-musl-openssl-3.0.x engine because `prisma generate` runs on this base.
# zlib 1.4-r0 for CVE-2026-4738 (the pinned image ships 1.3.2-r1), exactly as Identity does.
# The split is the point: `apk list -I zlib` prints `zlib-<version> <arch> ...` and $1 is the first word.
# hadolint ignore=SC2046
RUN apk add --no-cache openssl ca-certificates 'zlib=1.4-r0' && \
    set -- $(apk list -I zlib 2>/dev/null) && installed="${1#zlib-}" && \
    if [ "$installed" != "1.4-r0" ]; then \
      echo "zlib is '$installed', expected 1.4-r0 (CVE-2026-4738)" >&2; exit 1; \
    fi

FROM os AS base
# COREPACK_HOME outside /root: the migrate target runs pnpm as `node`, which cannot read root's
# home and would otherwise download pnpm again at run time, or fail with no network.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/corepack
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate && chmod -R a+rX /corepack
WORKDIR /build

# --- Dependencies: the lockfile decides, the token is a secret mount -----------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/portal/package.json apps/portal/package.json
COPY --from=vendor / vendor/
RUN --mount=type=secret,id=node_auth_token,required=true \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/node_auth_token)" > /tmp/auth.npmrc && \
    NPM_CONFIG_USERCONFIG=/tmp/auth.npmrc pnpm install --frozen-lockfile --store-dir /pnpm/store; \
    status=$?; rm -f /tmp/auth.npmrc; exit $status

# --- Build ---------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm prisma:generate && \
    pnpm --filter @control/api build && \
    pnpm --filter @control/portal build

# The API's production tree: its own dependencies only, with the Prisma client generated into it.
FROM build AS api-deploy
RUN --mount=type=secret,id=node_auth_token,required=true \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/node_auth_token)" > /tmp/auth.npmrc && \
    NPM_CONFIG_USERCONFIG=/tmp/auth.npmrc pnpm --filter @control/api deploy --prod --legacy \
      --store-dir /pnpm/store /out/api; \
    status=$?; rm -f /tmp/auth.npmrc; [ $status -eq 0 ] && \
    cp -r prisma /out/api/prisma && \
    cd /out/api && /build/apps/api/node_modules/.bin/prisma generate --schema prisma/schema.prisma

# --- api -----------------------------------------------------------------------------------------
FROM os AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deploy --chown=node:node /out/api ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# --- migrate -------------------------------------------------------------------------------------
# Run once per release, before the new API starts, with DATABASE_MIGRATION_URL (the owner role).
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["node", "scripts/migrate.mjs"]

# --- portal --------------------------------------------------------------------------------------
# From `os`, not the bare base, so the portal carries the same zlib fix as the API.
FROM os AS portal
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3200 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /build/apps/portal/.next/standalone ./
COPY --from=build --chown=node:node /build/apps/portal/.next/static ./apps/portal/.next/static
USER node
EXPOSE 3200
CMD ["node", "apps/portal/server.js"]

# The default target is the API.
FROM api
