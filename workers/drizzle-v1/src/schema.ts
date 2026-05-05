import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const article = pgTable(
  'Article',
  {
    id: text().primaryKey(),
    type: text().notNull(),
    status: text().notNull(),
    title: text().notNull(),
    desc: text().notNull(),
    content: text().notNull(),
    publishedAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    index('article_status_published_at_idx').on(
      table.status,
      table.publishedAt.desc(),
    ),
    index('article_published_at_idx').on(table.publishedAt.desc()),
  ],
);

export const column = pgTable('Column', {
  id: text().primaryKey(),
  name: text().notNull(),
});

export const tag = pgTable('Tag', {
  id: text().primaryKey(),
  name: text().notNull(),
});

export const series = pgTable('Series', {
  id: text().primaryKey(),
  name: text().notNull(),
});

export const articlesOnColumns = pgTable(
  'ArticlesOnColumns',
  {
    articleId: text()
      .notNull()
      .references(() => article.id, { onDelete: 'cascade' }),
    columnId: text()
      .notNull()
      .references(() => column.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.columnId] }),
    index('articles_on_columns_column_article_idx').on(
      table.columnId,
      table.articleId,
    ),
  ],
);

export const articlesOnTags = pgTable(
  'ArticlesOnTags',
  {
    articleId: text()
      .notNull()
      .references(() => article.id, { onDelete: 'cascade' }),
    tagId: text()
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.tagId] }),
    index('articles_on_tags_tag_article_idx').on(table.tagId, table.articleId),
  ],
);

export const seriesOnArticles = pgTable(
  'SeriesOnArticles',
  {
    articleId: text()
      .notNull()
      .references(() => article.id, { onDelete: 'cascade' }),
    seriesId: text()
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.seriesId] }),
    index('series_on_articles_series_article_idx').on(
      table.seriesId,
      table.articleId,
    ),
  ],
);

export const articleMetric = pgTable('ArticleMetric', {
  articleId: text()
    .primaryKey()
    .references(() => article.id, { onDelete: 'cascade' }),
  views: integer().notNull().default(0),
  likes: integer().notNull().default(0),
});

