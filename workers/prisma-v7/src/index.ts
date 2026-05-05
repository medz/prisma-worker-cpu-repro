import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

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

function createPrisma(env: Env) {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
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
    const prisma = createPrisma(env);
    const started = Date.now();

    if (url.pathname === '/health') {
      return json({ ok: true, worker: env.WORKER_VARIANT ?? 'prisma-v7' });
    }

    if (url.pathname === '/bench/articles') {
      const rows = await repeat(repeatCount, () =>
        prisma.article.findMany({
          where: {
            status: 'PUBLISHED',
            publishedAt: { lte: now },
          },
          orderBy: { publishedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            type: true,
            title: true,
            desc: true,
            publishedAt: true,
          },
        }),
      );

      return json({
        worker: 'prisma-v7',
        route: url.pathname,
        repeat: repeatCount,
        rows: rows.length,
        sample: rows[0]?.id,
        wallMs: Date.now() - started,
      });
    }

    if (url.pathname === '/bench/articles-by-column') {
      const rows = await repeat(repeatCount, () =>
        prisma.article.findMany({
          where: {
            status: 'PUBLISHED',
            publishedAt: { lte: now },
            columns: { some: { columnId } },
          },
          orderBy: { publishedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            type: true,
            title: true,
            desc: true,
            publishedAt: true,
          },
        }),
      );

      return json({
        worker: 'prisma-v7',
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
        prisma.article.findUnique({
          where: { id: articleId },
          include: {
            metric: true,
            columns: { include: { column: true } },
            tags: { include: { tag: true } },
            series: { include: { series: true } },
          },
        }),
      );

      return json({
        worker: 'prisma-v7',
        route: url.pathname,
        articleId,
        repeat: repeatCount,
        found: Boolean(article),
        columns: article?.columns.length ?? 0,
        tags: article?.tags.length ?? 0,
        series: article?.series.length ?? 0,
        wallMs: Date.now() - started,
      });
    }

    if (url.pathname === '/bench/related') {
      const source = await prisma.article.findUnique({
        where: { id: articleId },
        select: {
          id: true,
          type: true,
          tags: { select: { tagId: true } },
          series: { select: { seriesId: true } },
        },
      });
      if (!source) return json({ worker: 'prisma-v7', rows: 0 });

      const tagIds = source.tags.map((entry) => entry.tagId);
      const seriesIds = source.series.map((entry) => entry.seriesId);
      const relatedWhere = [
        tagIds.length ? { tags: { some: { tagId: { in: tagIds } } } } : void 0,
        seriesIds.length ?
          { series: { some: { seriesId: { in: seriesIds } } } }
        : void 0,
      ].filter((entry) => entry !== void 0);
      if (!relatedWhere.length) return json({ worker: 'prisma-v7', rows: 0 });

      const rows = await repeat(repeatCount, () =>
        prisma.article.findMany({
          where: {
            id: { not: articleId },
            status: 'PUBLISHED',
            publishedAt: { lte: now },
            OR: relatedWhere,
          },
          orderBy: { publishedAt: 'desc' },
          take: limit,
          select: { id: true, publishedAt: true },
        }),
      );

      return json({
        worker: 'prisma-v7',
        route: url.pathname,
        articleId,
        repeat: repeatCount,
        rows: rows.length,
        sample: rows[0]?.id,
        wallMs: Date.now() - started,
      });
    }

    return json({ error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
