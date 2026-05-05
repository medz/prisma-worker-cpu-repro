import pg from 'pg';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  await client.query(
    `
      insert into "Hello" ("id", "content")
      values ($1, $2)
      on conflict ("id") do update set "content" = excluded."content"
    `,
    [
      'hello',
      'Hello from a single-row table. This benchmark keeps database work intentionally tiny so Worker CPU reflects ORM/runtime overhead.',
    ],
  );
  await client.query('analyze "Hello"');
  console.log('seeded Hello: hello');
} finally {
  await client.end();
}
