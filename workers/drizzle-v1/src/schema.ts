import { pgTable, text } from 'drizzle-orm/pg-core';

export const hello = pgTable('Hello', {
  id: text().primaryKey(),
  content: text().notNull(),
});
