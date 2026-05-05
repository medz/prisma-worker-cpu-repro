# Prisma Worker CPU issue draft

## Title

High Cloudflare Worker CPU usage from Prisma ORM compared with Drizzle on equivalent request-scoped PostgreSQL queries

## Summary

We observed unusually high Cloudflare Worker CPU usage from Prisma ORM in a
production Worker using PostgreSQL. After migrating hot read APIs from Prisma to
Drizzle, Worker CPU usage dropped significantly.

This reproduction repository isolates the comparison outside the original
application. It uses a plain PostgreSQL `DATABASE_URL` and compares ORM/runtime
overhead under the same Cloudflare Worker runtime and same PostgreSQL workload.

## Important scope clarification

This is not a global-client-cache issue.

All variants use a request-scoped client lifecycle:

- Prisma v7 creates `PrismaPg` + `PrismaClient` inside the request handler.
- Drizzle v1 creates a Drizzle node-postgres client inside the request handler.
- Prisma Next should be tested the same way once EA packages are available.

We are not using isolate-level/global client caching because that is not a safe
or correct assumption for this Worker workload.

## CPU measurement source

Cloudflare's own CPU definition is useful here: CPU time measures time spent
executing Worker code, not time waiting on network/database I/O. The benchmark
therefore collects deployed Worker CPU/wall metrics through `wrangler tail
--format json` instead of relying on local timing.

Relevant Cloudflare docs:

- CPU time definition and limits: https://developers.cloudflare.com/workers/platform/limits/#cpu-time
- CPU profiling locally with DevTools: https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/
- Invocation CPU and wall time in Workers Logs / Tail / Logpush: https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/
- Local Worker execution and remote resources: https://developers.cloudflare.com/workers/development-testing/#local-development

## Variants

| Variant | Path | Status |
| --- | --- | --- |
| Prisma v7 | `workers/prisma-v7` | runnable, pinned to Prisma `7.8.0` |
| Drizzle v1 | `workers/drizzle-v1` | runnable, pinned to Drizzle `1.0.0-rc.1` |
| Prisma Next | `workers/prisma-next` | source slot, pending official EA package consumption |

Prisma Next reference:

- Repository: https://github.com/prisma/prisma-next
- The README describes Prisma Next as a TypeScript rewrite with a contract-first workflow and Postgres adapter support.
- At the time this repro was created, Prisma Next did not expose normal npm `next` dist-tags for `prisma`, `@prisma/client`, or `@prisma/adapter-pg`.

## Database workload

The schema models common content API access patterns:

- `Article`
- `Column`
- `Tag`
- `Series`
- `ArticlesOnColumns`
- `ArticlesOnTags`
- `SeriesOnArticles`
- `ArticleMetric`

Seed defaults:

- `Article`: 100,000 rows
- hot column: about 35% of articles
- older hot column: about 30% of articles, deliberately shifted away from the newest global articles
- tail column: sparse
- source article `a00000001` has many tags to stress relation filters

This intentionally covers:

- simple published article list
- article list by relation
- detail hydration with related records
- related article recommendation shape

## Benchmark routes

Each Worker exposes:

- `/bench/articles?limit=20&repeat=20`
- `/bench/articles-by-column?columnId=hot&limit=20&repeat=20`
- `/bench/articles-by-column?columnId=older-hot&limit=20&repeat=20`
- `/bench/detail?articleId=a00000001&repeat=20`
- `/bench/related?articleId=a00000001&limit=20&repeat=20`

`repeat` repeats the same ORM operation inside one Worker request. This increases
the CPU signal while keeping the request shape deterministic.

## Reproduction command

The repository includes a command that provisions a temporary Prisma Postgres
database, applies the schema, seeds deterministic data, deploys the runnable
Workers, attaches `wrangler tail` before each benchmark pass, and emits a
comparison report:

```sh
npm run benchmark:cloudflare -- \
  --region us-east-1 \
  --ttl 30m \
  --article-count 100000 \
  --requests 200 \
  --concurrency 20 \
  --repeat 20
```

The temporary database is created through:

```sh
npx create-db@latest create --json
```

The benchmark deletes deployed Workers after the run by default. If a process is
interrupted, run `npm run cleanup:cloudflare`. The temporary database is created
with the shortest supported TTL (`30m`) because `create-db` does not expose a
delete command.

## Metrics to collect

For each route and each Worker:

1. Workers invocation CPU time
2. Workers invocation wall time
3. Client-side p50/p95/p99 latency
4. PostgreSQL query count and mean latency, if `pg_stat_statements` is available
5. DevTools CPU profile for local `wrangler dev`, when useful for function-level attribution

Client-side latency is not a substitute for Worker CPU time.

## Expected table for results

| Route | Prisma v7 CPU p50 | Prisma v7 CPU p95 | Drizzle v1 CPU p50 | Drizzle v1 CPU p95 | Prisma Next CPU p50 | Prisma Next CPU p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/bench/articles` | TBD | TBD | TBD | TBD | TBD | TBD |
| `/bench/articles-by-column?columnId=hot` | TBD | TBD | TBD | TBD | TBD | TBD |
| `/bench/articles-by-column?columnId=older-hot` | TBD | TBD | TBD | TBD | TBD | TBD |
| `/bench/detail` | TBD | TBD | TBD | TBD | TBD | TBD |
| `/bench/related` | TBD | TBD | TBD | TBD | TBD | TBD |

## Production motivation

In the original production application, migrating hot public read APIs from
Prisma to Drizzle produced a visible CPU reduction in Cloudflare Workers. The
largest wins were on routes that perform relation-heavy public reads and article
hydration. The goal of this repository is to give Prisma engineering a smaller,
repeatable test case that can be run without application-specific code.

## Questions for Prisma

1. Is Prisma v7 expected to spend materially more CPU than Drizzle for
   request-scoped Cloudflare Worker usage with PostgreSQL?
2. Are there known Prisma v7 Worker runtime costs around client construction,
   query planning, generated model metadata, or relation query execution?
3. Is Prisma Next expected to materially reduce this CPU overhead?
4. Is there a recommended way to structure request-scoped Prisma clients for
   Workers that avoids this CPU profile without relying on global isolate
   caching?
