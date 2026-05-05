import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { hello } from './schema';

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

function createDb(env: Env) {
  return drizzle(env.DATABASE_URL);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = createDb(env);
    const started = Date.now();

    if (url.pathname === '/health') {
      return json({ ok: true, worker: env.WORKER_VARIANT ?? 'drizzle-v1' });
    }

    if (url.pathname === '/bench/hello') {
      const rows = await db
        .select({
          id: hello.id,
          content: hello.content,
        })
        .from(hello)
        .where(eq(hello.id, 'hello'))
        .limit(1);
      const row = rows[0];

      return json({
        worker: 'drizzle-v1',
        route: url.pathname,
        found: Boolean(row),
        contentLength: row?.content.length ?? 0,
        wallMs: Date.now() - started,
      });
    }

    return json({ error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
