drop table if exists "ArticleMetric";
drop table if exists "ArticlesOnColumns";
drop table if exists "ArticlesOnTags";
drop table if exists "SeriesOnArticles";
drop table if exists "Column";
drop table if exists "Tag";
drop table if exists "Series";
drop table if exists "Article";

create table "Article" (
  "id" text primary key,
  "type" text not null,
  "status" text not null,
  "title" text not null,
  "desc" text not null,
  "content" text not null,
  "publishedAt" timestamp(3) with time zone not null,
  "createdAt" timestamp(3) with time zone not null default now()
);

create table "Column" (
  "id" text primary key,
  "name" text not null
);

create table "Tag" (
  "id" text primary key,
  "name" text not null
);

create table "Series" (
  "id" text primary key,
  "name" text not null
);

create table "ArticlesOnColumns" (
  "articleId" text not null references "Article"("id") on delete cascade,
  "columnId" text not null references "Column"("id") on delete cascade,
  primary key ("articleId", "columnId")
);

create table "ArticlesOnTags" (
  "articleId" text not null references "Article"("id") on delete cascade,
  "tagId" text not null references "Tag"("id") on delete cascade,
  primary key ("articleId", "tagId")
);

create table "SeriesOnArticles" (
  "articleId" text not null references "Article"("id") on delete cascade,
  "seriesId" text not null references "Series"("id") on delete cascade,
  primary key ("articleId", "seriesId")
);

create table "ArticleMetric" (
  "articleId" text primary key references "Article"("id") on delete cascade,
  "views" integer not null default 0,
  "likes" integer not null default 0
);

create index "article_status_published_at_idx"
  on "Article" ("status", "publishedAt" desc);

create index "article_published_at_idx"
  on "Article" ("publishedAt" desc);

create index "articles_on_columns_column_article_idx"
  on "ArticlesOnColumns" ("columnId", "articleId");

create index "articles_on_tags_tag_article_idx"
  on "ArticlesOnTags" ("tagId", "articleId");

create index "series_on_articles_series_article_idx"
  on "SeriesOnArticles" ("seriesId", "articleId");

