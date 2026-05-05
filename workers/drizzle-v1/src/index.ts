import { and, desc, eq, exists, inArray, lte, ne, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  article,
  articleMetric,
  articlesOnColumns,
  articlesOnTags,
  column,
  series,
  seriesOnArticles,
  tag,
} from './schema';

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

function createDb(env: Env) {
  return drizzle(env.DATABASE_URL);
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
    const db = createDb(env);
    const started = Date.now();

    if (url.pathname === '/health') {
      return json({ ok: true, worker: env.WORKER_VARIANT ?? 'drizzle-v1' });
    }

    if (url.pathname === '/bench/articles') {
      const rows = await repeat(repeatCount, () =>
        db
          .select({
            id: article.id,
            type: article.type,
            title: article.title,
            desc: article.desc,
            publishedAt: article.publishedAt,
          })
          .from(article)
          .where(
            and(
              eq(article.status, 'PUBLISHED'),
              lte(article.publishedAt, now),
            ),
          )
          .orderBy(desc(article.publishedAt))
          .limit(limit),
      );

      return json({
        worker: 'drizzle-v1',
        route: url.pathname,
        repeat: repeatCount,
        rows: rows.length,
        sample: rows[0]?.id,
        wallMs: Date.now() - started,
      });
    }

    if (url.pathname === '/bench/articles-by-column') {
      const rows = await repeat(repeatCount, () =>
        db
          .select({
            id: article.id,
            type: article.type,
            title: article.title,
            desc: article.desc,
            publishedAt: article.publishedAt,
          })
          .from(article)
          .where(
            and(
              eq(article.status, 'PUBLISHED'),
              lte(article.publishedAt, now),
              exists(
                db
                  .select({ articleId: articlesOnColumns.articleId })
                  .from(articlesOnColumns)
                  .where(
                    and(
                      eq(articlesOnColumns.articleId, article.id),
                      eq(articlesOnColumns.columnId, columnId),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(desc(article.publishedAt))
          .limit(limit),
      );

      return json({
        worker: 'drizzle-v1',
        route: url.pathname,
        columnId,
        repeat: repeatCount,
        rows: rows.length,
        sample: rows[0]?.id,
        wallMs: Date.now() - started,
      });
    }

    if (url.pathname === '/bench/detail') {
      const detail = await repeat(repeatCount, async () => {
        const [row] = await db
          .select()
          .from(article)
          .where(eq(article.id, articleId))
          .limit(1);
        if (!row) return void 0;

        const metric = await db
          .select()
          .from(articleMetric)
          .where(eq(articleMetric.articleId, articleId));
        const columnRows = await db
          .select({ articleId: articlesOnColumns.articleId, column })
          .from(articlesOnColumns)
          .innerJoin(column, eq(articlesOnColumns.columnId, column.id))
          .where(eq(articlesOnColumns.articleId, articleId));
        const tagRows = await db
          .select({ articleId: articlesOnTags.articleId, tag })
          .from(articlesOnTags)
          .innerJoin(tag, eq(articlesOnTags.tagId, tag.id))
          .where(eq(articlesOnTags.articleId, articleId));
        const seriesRows = await db
          .select({ articleId: seriesOnArticles.articleId, series })
          .from(seriesOnArticles)
          .innerJoin(series, eq(seriesOnArticles.seriesId, series.id))
          .where(eq(seriesOnArticles.articleId, articleId));

        return { row, metric, columnRows, tagRows, seriesRows };
      });

      return json({
        worker: 'drizzle-v1',
        route: url.pathname,
        articleId,
        repeat: repeatCount,
        found: Boolean(detail),
        columns: detail?.columnRows.length ?? 0,
        tags: detail?.tagRows.length ?? 0,
        series: detail?.seriesRows.length ?? 0,
        wallMs: Date.now() - started,
      });
    }

    if (url.pathname === '/bench/related') {
      const [source] = await db
        .select({ id: article.id, type: article.type })
        .from(article)
        .where(eq(article.id, articleId))
        .limit(1);
      if (!source) return json({ worker: 'drizzle-v1', rows: 0 });

      const tagRows = await db
        .select({ tagId: articlesOnTags.tagId })
        .from(articlesOnTags)
        .where(eq(articlesOnTags.articleId, articleId));
      const seriesRows = await db
        .select({ seriesId: seriesOnArticles.seriesId })
        .from(seriesOnArticles)
        .where(eq(seriesOnArticles.articleId, articleId));
      const tagIds = tagRows.map((entry) => entry.tagId);
      const seriesIds = seriesRows.map((entry) => entry.seriesId);
      const relatedFilter = or(
        tagIds.length ?
          exists(
            db
              .select({ articleId: articlesOnTags.articleId })
              .from(articlesOnTags)
              .where(
                and(
                  eq(articlesOnTags.articleId, article.id),
                  inArray(articlesOnTags.tagId, tagIds),
                ),
              ),
          )
        : void 0,
        seriesIds.length ?
          exists(
            db
              .select({ articleId: seriesOnArticles.articleId })
              .from(seriesOnArticles)
              .where(
                and(
                  eq(seriesOnArticles.articleId, article.id),
                  inArray(seriesOnArticles.seriesId, seriesIds),
                ),
              ),
          )
        : void 0,
      );

      const rows = await repeat(repeatCount, () =>
        db
          .select({ id: article.id, publishedAt: article.publishedAt })
          .from(article)
          .where(
            and(
              ne(article.id, articleId),
              eq(article.status, 'PUBLISHED'),
              lte(article.publishedAt, now),
              relatedFilter,
            ),
          )
          .orderBy(desc(article.publishedAt))
          .limit(limit),
      );

      return json({
        worker: 'drizzle-v1',
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
