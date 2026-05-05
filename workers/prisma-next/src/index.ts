import postgres from '@prisma-next/postgres/runtime';
import contractJson from '../.prisma/contract.json' with { type: 'json' };
import type { Contract } from '../.prisma/contract.d';

type Env = {
  DATABASE_URL: string;
  WORKER_VARIANT?: string;
};

const DEFAULT_LIMIT = 20;
const DEFAULT_REPEAT = 1;

function getNumber(url: URL, name: string, fallback: number, max: number) {
  const value = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      ...(init?.headers ?? {}),
    },
  });
}

async function repeat<T>(count: number, task: () => Promise<T>) {
  let last: T | undefined;
  for (let index = 0; index < count; index += 1) {
    last = await task();
  }
  return last as T;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const limit = getNumber(url, 'limit', DEFAULT_LIMIT, 100);
    const repeatCount = getNumber(url, 'repeat', DEFAULT_REPEAT, 200);
    const columnId = url.searchParams.get('columnId') ?? 'hot';
    const articleId = url.searchParams.get('articleId') ?? 'a00000001';
    const now = new Date();
    const db = postgres<Contract>({ contractJson, url: env.DATABASE_URL });
    const started = Date.now();

    if (url.pathname === '/health') {
      return json({ ok: true, worker: env.WORKER_VARIANT ?? 'prisma-next' });
    }

    if (url.pathname === '/bench/articles') {
      const rows = await repeat(repeatCount, () =>
        db.orm.articles
          .where((article) => article.status.equals('PUBLISHED'))
          .where((article) => article.publishedAt.lte(now))
          .orderBy((article) => article.publishedAt.desc())
          .select('id', 'type', 'title', 'desc', 'publishedAt')
          .take(limit)
          .all(),
      );

      return json({
        worker: 'prisma-next',
        route: url.pathname,
        repeat: repeatCount,
        rows: rows.length,
        sample: rows[0]?.id,
        wallMs: Date.now() - started,
      });
    }

    if (url.pathname === '/bench/articles-by-column') {
      const rows = await repeat(repeatCount, () =>
        db.orm.articles
          .where((article) => article.status.equals('PUBLISHED'))
          .where((article) => article.publishedAt.lte(now))
          .where((article) =>
            article.id.in(
              db.orm.articlesOnColumns
                .where((entry) => entry.columnId.equals(columnId))
                .select('articleId'),
            ),
          )
          .orderBy((article) => article.publishedAt.desc())
          .select('id', 'type', 'title', 'desc', 'publishedAt')
          .take(limit)
          .all(),
      );

      return json({
        worker: 'prisma-next',
        route: url.pathname,
        columnId,
        repeat: repeatCount,
        rows: rows.length,
        sample: rows[0]?.id,
        wallMs: Date.now() - started,
      });
    }

    if (url.pathname === '/bench/detail') {
      const article = await repeat(repeatCount, () =>
        db.orm.articles.where({ id: articleId }).take(1).all(),
      );

      return json({
        worker: 'prisma-next',
        route: url.pathname,
        articleId,
        repeat: repeatCount,
        found: article.length > 0,
        wallMs: Date.now() - started,
      });
    }

    return json({
      error:
        'The Prisma Next worker is a source-compatible slot. Re-run after Prisma Next EA packages are available.',
    }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;

