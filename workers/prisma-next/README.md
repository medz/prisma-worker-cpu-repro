# Prisma Next worker slot

Prisma Next currently lives in [`prisma/prisma-next`](https://github.com/prisma/prisma-next)
as a development repository. It is not published as a normal npm dist-tag yet.

This directory is intentionally kept outside the root npm workspaces until
Prisma Next publishes Early Access packages or provides a supported package
consumption path. The worker source mirrors the same single-table benchmark
route used by the Prisma v7 and Drizzle v1 workers, and should be wired to the
official Prisma Next packages from the `vendor/prisma-next` submodule during the
EA test.

Expected activation steps once Prisma Next packages are consumable:

1. Update `package.json` dependencies to the official EA package names/versions.
2. Run `prisma-next contract emit` against `prisma/schema.psl`.
3. Build and deploy this Worker with the same `DATABASE_URL` secret as the other
   two workers.
4. Re-run the same `/bench/hello` load tests and compare Workers CPU/wall metrics.
