# Dependency advisories and how each was answered

`pnpm audit --audit-level high` is a CI gate (`.github/workflows/ci.yml`). This file records what
tripped it and the remedy, and for every override, why nothing narrower was possible and how the
forced version was verified. The order of preference is the product repositories': a lockfile
refresh within the declared range · a package upgrade · an override verified against the tool that
consumes it · documenting the exposure and leaving the gate red.

Audit on 2026-10-28, before: 2 critical, 5 high. After: none at or above the gate; one low (below).

## Upgrades

| Advisory                                            | Package                   | Remedy                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr (critical) | `tinypool` via `vitest` 3 | **Vitest 4** (`^4.1.12`): it no longer uses tinypool. No configuration change was needed; API 43/43 and portal 10/10 pass                                                                                                    |
| GHSA-mrhx-c7xc-m3w5 (high)                          | `zod` 3                   | **Zod 4** (`^4.6.7`): no 3.x release is fixed. One type change (`ZodType<Output, Input>` replaces `ZodType<Output, ZodTypeDef, Input>` in `core/validation.ts`); issue paths are stringified, since Zod 4 allows symbol keys |

## Overrides (`pnpm.overrides` in `package.json`)

| Override                                              | Why an override                                                                                                           | Verified by                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `multer: ^2.5.0` (high, 4 advisories, fixed in 2.5.0) | `@nestjs/platform-express@11.2.8`, the latest release, pins `multer` **exactly** at `2.4.0`                               | The API serves no upload route; its suite runs on `@nestjs/platform-express` with multer 2.5.0 and passes |
| `deepmerge-ts: ^8.0.2` (high)                         | `@prisma/config` pins `7.1.5` exactly, in every Prisma release including 7.x — the same finding and remedy as munaxa-work | `prisma generate`, `prisma migrate deploy` and the e2e suite against PostgreSQL                           |
| `postcss: ^8.5.25` (2 high, 2 moderate)               | `next@15.5.28` pins `postcss` **exactly** at `8.4.31`                                                                     | `next build` of the portal and its tests                                                                  |

`next` itself was raised to `^15.5.28`, the release the lockfile already resolved, so a fresh
resolution cannot fall back to a vulnerable 15.x.

## Remaining, below the gate

**`deepmerge` ≤ 4.3.1 — low, prototype poisoning of merged objects.** No fixed version exists
(the advisory's patched range is empty). Reached only through
`@nestjs/cli > fork-ts-checker-webpack-plugin > deepmerge`: the build-time type checker of the Nest
CLI, which merges its own configuration. It is not in the API's runtime, its image or the portal.
