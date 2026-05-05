# Prisma Worker CPU reproduction

This repository is a focused Cloudflare Workers reproduction for comparing ORM
CPU overhead on the smallest useful PostgreSQL workload. It intentionally uses a
single `Hello` table with one row so database shape, relation complexity, data
volume, and index choices do not dominate the result.

The comparison keeps these variables the same:

- same PostgreSQL database
- same one-table schema and one seeded row
- same `/bench/hello` route
- same request-scoped client lifecycle
- same Cloudflare Worker runtime
- different ORM implementation

## Workers

| Worker | Status | Notes |
| --- | --- | --- |
| `workers/prisma-v7` | runnable | Prisma ORM `7.8.0` with `@prisma/adapter-pg` and Worker runtime output |
| `workers/drizzle-v1` | runnable | Drizzle ORM `1.0.0-rc.1` with node-postgres |
| `workers/prisma-next` | source slot | Prisma Next is currently in `prisma/prisma-next`, not published as normal npm packages |

## Why request-scoped clients?

Every Worker creates its ORM/database client inside the request handler. This is
intentional. We are not testing isolate/global client caching, and we are not
using global client reuse as a workaround.

The comparison is:

> With the correct Cloudflare Worker request lifecycle, how much CPU does each
> ORM spend per request for the same minimal query?

## Setup

Use a regular PostgreSQL database reachable from Workers.

```sh
export DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require'
npm install
npm run setup:db
npm run seed
npm run generate:prisma-v7
npm run build
```

Set the same `DATABASE_URL` secret on both runnable Workers:

```sh
npx wrangler secret put DATABASE_URL -c workers/prisma-v7/wrangler.jsonc
npx wrangler secret put DATABASE_URL -c workers/drizzle-v1/wrangler.jsonc
```

Deploy:

```sh
npm run deploy:prisma-v7
npm run deploy:drizzle-v1
```

## Benchmark Route

All runnable Workers expose:

- `GET /health`
- `GET /bench/hello`

`/bench/hello` selects the single seeded row by primary key and returns its
content length. Each measured request represents one request-scoped ORM client
lifecycle plus one minimal query.

Run a client-side load test:

```sh
npm run bench -- --url 'https://<worker-url>/bench/hello' --requests 200 --concurrency 20
```

Client-side latency is not CPU time. Use Workers Logs, Tail Workers, Logpush, or
Workers Observability to collect `cpuTime` and `wallTime` for the deployed
Workers.

## One-command Cloudflare Benchmark

The preferred reproduction command provisions a temporary Prisma Postgres
database, deploys the runnable Workers, attaches `wrangler tail` before each
benchmark pass, sends the benchmark traffic, and writes a CPU/wall comparison
report:

```sh
npm run benchmark:cloudflare
```

The defaults are intentionally configured to make ORM CPU differences visible
even though the database workload is only one primary-key lookup:

| Setting | Default |
| --- | ---: |
| Table | `Hello` |
| Seeded rows | `1` |
| Benchmark routes | `1` |
| Measured requests per route | `60` |
| Client concurrency | `6` |
| Warmup requests per route | `5` |
| Temporary DB TTL | `30m` |

The command uses `npx create-db@latest create --json --ttl 30m` for the
temporary PostgreSQL database. You can also provide an existing database:

```sh
npm run benchmark:cloudflare -- --database-url "$DATABASE_URL"
```

Reports are written to `.tmp/cloudflare-benchmark/<run-id>/report.md` and
`report.json`. CPU and wall values in those reports come from
`wrangler tail --format json`, not local request timing. The generated Markdown
report includes route-level CPU/wall p50/p95 plus a Prisma v7 vs Drizzle v1 CPU
ratio table.

The command deletes the deployed benchmark Workers in a `finally` block by
default. If a run is interrupted, clean up Cloudflare Worker resources manually:

```sh
npm run cleanup:cloudflare
```

`create-db` temporary databases do not expose a delete command; the benchmark
uses a `30m` TTL by default.

Prisma Next is listed as a third variant, but it is skipped until the official
Early Access packages or another supported install path are available.

## Prisma Next

Prisma Next currently lives at <https://github.com/prisma/prisma-next>.

The source slot in `workers/prisma-next` mirrors the same route shape, but it is
not included in the root `npm install` or `npm run build` until Prisma Next
publishes Early Access packages or a supported external consumption path. See
`workers/prisma-next/README.md`.

## Report

`REPORT.md` contains the issue report for Prisma.
