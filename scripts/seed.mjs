import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const ARTICLE_COUNT = Number(process.env.ARTICLE_COUNT ?? 100_000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 2_000);

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

function articleId(index) {
  return `a${index.toString().padStart(8, '0')}`;
}

function values(rows, columns) {
  const params = [];
  const sql = rows
    .map((row, rowIndex) => {
      const slots = columns.map((column, columnIndex) => {
        params.push(row[column]);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${slots.join(', ')})`;
    })
    .join(', ');

  return { sql, params };
}

async function insertRows(client, table, rows, columns, suffix = '') {
  if (!rows.length) return;

  const { sql, params } = values(rows, columns);
  await client.query(
    `insert into "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) values ${sql} ${suffix}`,
    params,
  );
}

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  await client.query('begin');

  await insertRows(
    client,
    'Column',
    [
      { id: 'hot', name: 'Hot column' },
      { id: 'older-hot', name: 'Older hot column' },
      { id: 'tail', name: 'Tail column' },
    ],
    ['id', 'name'],
    'on conflict do nothing',
  );

  await insertRows(
    client,
    'Tag',
    Array.from({ length: 80 }, (_, index) => ({
      id: `tag-${index + 1}`,
      name: `Tag ${index + 1}`,
    })),
    ['id', 'name'],
    'on conflict do nothing',
  );

  await insertRows(
    client,
    'Series',
    Array.from({ length: 12 }, (_, index) => ({
      id: `series-${index + 1}`,
      name: `Series ${index + 1}`,
    })),
    ['id', 'name'],
    'on conflict do nothing',
  );

  for (let start = 1; start <= ARTICLE_COUNT; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, ARTICLE_COUNT);
    const articles = [];
    const metrics = [];
    const columnRelations = [];
    const tagRelations = [];
    const seriesRelations = [];

    for (let index = start; index <= end; index += 1) {
      const id = articleId(index);
      const hash = crypto.createHash('sha1').update(id).digest('hex');
      const publishedAt = new Date(Date.now() - index * 60_000);

      articles.push({
        id,
        type: index % 9 === 0 ? 'VIDEO' : 'NORMAL',
        status: index % 20 === 0 ? 'DRAFT' : 'PUBLISHED',
        title: `Article ${index}`,
        desc: `Description ${hash}`,
        content: hash.repeat(80),
        publishedAt,
        createdAt: new Date(publishedAt.getTime() - 86_400_000),
      });
      metrics.push({
        articleId: id,
        views: index * 7,
        likes: index % 997,
      });

      if (index <= Math.floor(ARTICLE_COUNT * 0.35)) {
        columnRelations.push({ articleId: id, columnId: 'hot' });
      }
      if (
        index > Math.floor(ARTICLE_COUNT * 0.45) &&
        index <= Math.floor(ARTICLE_COUNT * 0.75)
      ) {
        columnRelations.push({ articleId: id, columnId: 'older-hot' });
      }
      if (index % 211 === 0) {
        columnRelations.push({ articleId: id, columnId: 'tail' });
      }

      for (let tag = 1; tag <= 6; tag += 1) {
        if (index % (tag + 2) === 0) {
          tagRelations.push({ articleId: id, tagId: `tag-${tag}` });
        }
      }
      if (index === 1) {
        for (let tag = 1; tag <= 60; tag += 1) {
          tagRelations.push({ articleId: id, tagId: `tag-${tag}` });
        }
      }

      if (index % 50 === 0 || index === 1) {
        seriesRelations.push({
          articleId: id,
          seriesId: `series-${(index % 12) + 1}`,
        });
      }
    }

    await insertRows(client, 'Article', articles, [
      'id',
      'type',
      'status',
      'title',
      'desc',
      'content',
      'publishedAt',
      'createdAt',
    ]);
    await insertRows(client, 'ArticleMetric', metrics, [
      'articleId',
      'views',
      'likes',
    ]);
    await insertRows(
      client,
      'ArticlesOnColumns',
      columnRelations,
      ['articleId', 'columnId'],
      'on conflict do nothing',
    );
    await insertRows(
      client,
      'ArticlesOnTags',
      tagRelations,
      ['articleId', 'tagId'],
      'on conflict do nothing',
    );
    await insertRows(
      client,
      'SeriesOnArticles',
      seriesRelations,
      ['articleId', 'seriesId'],
      'on conflict do nothing',
    );

    process.stdout.write(`seeded ${end}/${ARTICLE_COUNT}\r`);
  }

  await client.query('commit');
  await client.query('analyze');
  process.stdout.write(`seeded ${ARTICLE_COUNT}/${ARTICLE_COUNT}\n`);
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}

