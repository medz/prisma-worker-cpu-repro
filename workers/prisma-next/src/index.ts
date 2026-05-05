import postgres from '@prisma-next/postgres/runtime';
import contractJson from '../.prisma/contract.json' with { type: 'json' };
import type { Contract } from '../.prisma/contract.d';

type Env = {
  DATABASE_URL: string;
  WORKER_VARIANT?: string;
};

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      ...(init?.headers ?? {}),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = postgres<Contract>({ contractJson, url: env.DATABASE_URL });
    const started = Date.now();

    if (url.pathname === '/health') {
      return json({ ok: true, worker: env.WORKER_VARIANT ?? 'prisma-next' });
    }

    if (url.pathname === '/bench/hello') {
      const rows = await db.orm.hello
        .where({ id: 'hello' })
        .select('id', 'content')
        .take(1)
        .all();
      const row = rows[0];

      return json({
        worker: 'prisma-next',
        route: url.pathname,
        found: Boolean(row),
        contentLength: row?.content.length ?? 0,
        wallMs: Date.now() - started,
      });
    }

    return json({
      error:
        'The Prisma Next worker is a source-compatible slot. Re-run after Prisma Next EA packages are available.',
    }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
