import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

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

function createPrisma(env: Env) {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const prisma = createPrisma(env);
    const started = Date.now();

    if (url.pathname === '/health') {
      return json({ ok: true, worker: env.WORKER_VARIANT ?? 'prisma-v7' });
    }

    if (url.pathname === '/bench/hello') {
      const row = await prisma.hello.findUnique({
        where: { id: 'hello' },
        select: {
          id: true,
          content: true,
        },
      });

      return json({
        worker: 'prisma-v7',
        route: url.pathname,
        found: Boolean(row),
        contentLength: row?.content.length ?? 0,
        wallMs: Date.now() - started,
      });
    }

    return json({ error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
