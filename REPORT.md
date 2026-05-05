# Prisma Worker CPU issue report

## Title

High Cloudflare Worker CPU usage from Prisma ORM compared with Drizzle on an
equivalent request-scoped PostgreSQL primary-key lookup

## Summary

We observed unusually high Cloudflare Worker CPU usage from Prisma ORM in a
production Worker using PostgreSQL. After migrating hot read APIs from Prisma to
Drizzle, Worker CPU usage dropped significantly.

This repository isolates the comparison outside the production application. It
uses the same PostgreSQL database, one-table schema, one seeded row, Worker
runtime, request lifecycle, and benchmark route for each ORM variant. The goal
is to measure ORM/runtime CPU overhead in Workers, not database query
performance.

Repository: https://github.com/medz/prisma-worker-cpu-repro

## Important Scope Clarification

This is not a global-client-cache issue.

All variants create ORM/database clients inside the request handler:

- Prisma v7 creates `PrismaPg` + `PrismaClient` inside `fetch()`.
- Drizzle v1 creates a Drizzle node-postgres client inside `fetch()`.
- Prisma Next should be tested with the same request-scoped lifecycle once its
  Early Access packages or another supported install path are available.

We are not using isolate-level/global client caching because that is not a safe
or correct assumption for this Worker workload.

## What The Benchmark Measures

The benchmark measures deployed Cloudflare Worker invocation CPU and wall time.
It does not use local timing as the CPU source.

For each route and Worker variant, the command:

1. Starts `wrangler tail --format json`.
2. Sends warmup requests that are excluded from the measurement.
3. Sends measured requests with deterministic benchmark query parameters.
4. Reads `cpuTime` and `wallTime` from the Cloudflare tail events.
5. Writes a per-run Markdown and JSON report, including Prisma/Drizzle CPU
   ratios.

Client-side latency is included only as supporting context.

## One-command Reproduction

Prerequisites:

- Node.js 24+
- npm
- Cloudflare Wrangler login with Workers deploy and tail permissions

Run:

```sh
git clone https://github.com/medz/prisma-worker-cpu-repro.git
cd prisma-worker-cpu-repro
npm install
npm run benchmark:cloudflare
```

The default command is intentionally configured to produce visible CPU signal
while keeping database work minimal:

| Setting | Default | Reason |
| --- | ---: | --- |
| Table | `Hello` | Removes relation shape and table-count differences from the comparison. |
| Seeded rows | `1` | Keeps database data volume effectively out of scope. |
| Benchmark routes | `1` | All variants perform the same primary-key lookup route. |
| Measured requests per route | `60` | Enough tail samples for p50/p95 without an excessive run. |
| Client concurrency | `6` | Exercises Worker request handling without making tail sampling too noisy. |
| Warmup requests per route | `5` | Excludes first-request startup from steady-route CPU comparison. |
| Temporary DB TTL | `30m` | Shortest supported `create-db` TTL, limiting retained resources. |

The command provisions a temporary Prisma Postgres database via:

```sh
npx create-db@latest create --json --ttl 30m
```

It then applies `packages/db/schema.sql`, seeds the single `Hello` row, builds
and deploys the runnable Workers, runs the benchmark, writes the reports, and
deletes the deployed Workers in a `finally` block.

If a process is interrupted, run:

```sh
npm run cleanup:cloudflare
```

## Output

Each run writes:

- `.tmp/cloudflare-benchmark/<run-id>/report.md`
- `.tmp/cloudflare-benchmark/<run-id>/report.json`
- `.tmp/cloudflare-benchmark/<run-id>/<worker>-tail.jsonl`

The Markdown report contains:

- route-level CPU p50/p95
- route-level wall p50/p95
- client-side latency p95
- tail event count
- Prisma v7 vs Drizzle v1 CPU ratio table
- skipped Prisma Next status, when Prisma Next packages are not available

## Variants

| Variant | Path | Status |
| --- | --- | --- |
| Prisma v7 | `workers/prisma-v7` | runnable, pinned to Prisma `7.8.0` |
| Drizzle v1 | `workers/drizzle-v1` | runnable, pinned to Drizzle `1.0.0-rc.1` |
| Prisma Next | `workers/prisma-next` | source slot, pending official EA package consumption |

Prisma Next reference:

- Repository: https://github.com/prisma/prisma-next
- The public source currently shows a workspace-based monorepo.
- At the time this repo was prepared, normal npm `next` dist-tags were not
  available for `prisma`, `@prisma/client`, or `@prisma/adapter-pg`.

## Database Workload

The schema is intentionally tiny:

```sql
create table "Hello" (
  "id" text primary key,
  "content" text not null
);
```

Seed data:

- one row
- `id = 'hello'`
- fixed text content

This avoids bringing database schema differences, query planning complexity,
join strategies, sort performance, or large result hydration into the primary
comparison.

## Benchmark Route

Each runnable Worker exposes the same route:

- `/bench/hello`

Each request selects the same row by primary key and returns a small JSON
response containing whether the row was found and the content length. This keeps
the main comparison focused on per-request ORM/runtime overhead rather than
database round-trip amplification.

## Expected Result

For an equivalent one-row primary-key lookup and request-scoped lifecycle,
Prisma should ideally be in the same order of magnitude as Drizzle for Worker
invocation CPU time. If Prisma v7 is consistently and materially higher on CPU
p50/p95, the result would suggest CPU overhead in Prisma's Worker runtime path,
client construction, generated metadata, query planning, query execution, or
result hydration.

## Questions For Prisma

1. Is Prisma v7 expected to spend materially more CPU than Drizzle for
   request-scoped Cloudflare Worker usage with PostgreSQL?
2. Are there known Prisma v7 Worker runtime costs around client construction,
   query planning, generated model metadata, query execution, or result
   hydration even for a primary-key lookup?
3. Is Prisma Next expected to materially reduce this CPU overhead?
4. Once Prisma Next Early Access is available, what is the recommended package
   or install path for running this same Worker benchmark?
5. Is there a recommended way to structure request-scoped Prisma clients for
   Workers that avoids this CPU profile without relying on global isolate
   caching?
