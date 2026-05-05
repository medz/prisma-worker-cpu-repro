import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_ARTICLE_COUNT = 100_000;
const DEFAULT_BATCH_SIZE = 2_000;
const DEFAULT_REQUESTS = 60;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_LIMIT = 20;
const DEFAULT_REPEAT = 50;
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_TTL = '30m';
const DEFAULT_TAIL_WARMUP_MS = 10_000;
const DEFAULT_TAIL_SETTLE_MS = 5_000;
const DEFAULT_WARMUP_REQUESTS = 5;
const DEFAULT_ROUTES = [
  { id: 'articles', path: '/bench/articles' },
  { id: 'articles-by-column-hot', path: '/bench/articles-by-column', params: { columnId: 'hot' } },
  {
    id: 'articles-by-column-older-hot',
    path: '/bench/articles-by-column',
    params: { columnId: 'older-hot' },
  },
  { id: 'detail', path: '/bench/detail', params: { articleId: 'a00000001' } },
  { id: 'related', path: '/bench/related', params: { articleId: 'a00000001' } },
];
const WORKERS = {
  'prisma-v7': {
    id: 'prisma-v7',
    name: 'prisma-worker-cpu-prisma-v7',
    config: 'workers/prisma-v7/wrangler.jsonc',
    buildScript: 'build:prisma-v7',
  },
  'drizzle-v1': {
    id: 'drizzle-v1',
    name: 'prisma-worker-cpu-drizzle-v1',
    config: 'workers/drizzle-v1/wrangler.jsonc',
    buildScript: 'build:drizzle-v1',
  },
  'prisma-next': {
    id: 'prisma-next',
    name: 'prisma-worker-cpu-prisma-next',
    config: 'workers/prisma-next/wrangler.jsonc',
    buildScript: 'build:prisma-next',
    packageJson: 'workers/prisma-next/package.json',
  },
};

const args = parseArgs(process.argv.slice(2));
const runId = args.get('run-id') ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const articleCount = getNumberArg('article-count', DEFAULT_ARTICLE_COUNT);
const batchSize = getNumberArg('batch-size', DEFAULT_BATCH_SIZE);
const requests = getNumberArg('requests', DEFAULT_REQUESTS);
const concurrency = getNumberArg('concurrency', DEFAULT_CONCURRENCY);
const limit = getNumberArg('limit', DEFAULT_LIMIT);
const repeat = getNumberArg('repeat', DEFAULT_REPEAT);
const region = args.get('region') ?? DEFAULT_REGION;
const ttl = args.get('ttl') ?? DEFAULT_TTL;
const tailWarmupMs = getNumberArg('tail-warmup-ms', DEFAULT_TAIL_WARMUP_MS);
const tailSettleMs = getNumberArg('tail-settle-ms', DEFAULT_TAIL_SETTLE_MS);
const warmupRequests = getNumberArg('warmup-requests', DEFAULT_WARMUP_REQUESTS);
const cloudflareAccountId = args.get('account-id') ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const keepWorkers = args.has('keep-workers');
const outputDir = path.resolve(ROOT_DIR, args.get('output') ?? `.tmp/cloudflare-benchmark/${runId}`);
const workerIds = (args.get('workers') ?? 'prisma-v7,drizzle-v1,prisma-next')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

if (args.has('help')) {
  printUsage();
  process.exit(0);
}

await main();

async function main() {
  await mkdir(outputDir, { recursive: true });
  await ensureDependencies();
  await checkWranglerAuth();

  const databaseUrl = args.get('database-url') ?? process.env.DATABASE_URL ?? await createTemporaryDatabase();

  await applySchema(databaseUrl);
  await run('node', ['scripts/seed.mjs'], {
    env: {
      DATABASE_URL: databaseUrl,
      ARTICLE_COUNT: String(articleCount),
      BATCH_SIZE: String(batchSize),
    },
  });

  await buildWorkers(workerIds, databaseUrl);

  const report = {
    runId,
    createdAt: new Date().toISOString(),
    database: {
      source: args.has('database-url') || process.env.DATABASE_URL ? 'provided' : 'create-db',
      region,
      ttl,
      articleCount,
    },
    benchmark: {
      requests,
      concurrency,
      limit,
      repeat,
      tailWarmupMs,
      tailSettleMs,
      warmupRequests,
    },
    cleanup: {
      workersDeleted: !keepWorkers,
      database: args.has('database-url') || process.env.DATABASE_URL ?
        'provided database not modified beyond schema/data reset'
      : `temporary Prisma Postgres database expires after ${ttl}`,
    },
    workers: [],
  };

  const deployedWorkers = [];
  try {
    for (const workerId of workerIds) {
      const worker = WORKERS[workerId];
      if (!worker) {
        report.workers.push({ id: workerId, status: 'skipped', reason: 'Unknown worker id' });
        continue;
      }

      if (!isRunnable(worker)) {
        report.workers.push({
          id: worker.id,
          name: worker.name,
          status: 'skipped',
          reason: 'Prisma Next packages are not yet configured as installable dependencies.',
        });
        continue;
      }

      const deployed = await deployWorker(worker, databaseUrl, deployedWorkers);
      const tested = await benchmarkWorker(worker, deployed.url);
      report.workers.push({
        id: worker.id,
        name: worker.name,
        status: 'completed',
        url: deployed.url,
        routes: tested,
      });
    }
  } finally {
    if (!keepWorkers) {
      await cleanupWorkers(deployedWorkers);
    }
  }

  await writeReport(report);
  console.log(`\nReport written to ${path.relative(ROOT_DIR, outputDir)}`);
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) continue;

    const [key, inlineValue] = raw.slice(2).split('=', 2);
    if (inlineValue !== void 0) {
      parsed.set(key, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed.set(key, 'true');
      continue;
    }

    parsed.set(key, next);
    index += 1;
  }
  return parsed;
}

function getNumberArg(name, fallback) {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function printUsage() {
  console.log(`Usage:
  npm run benchmark:cloudflare -- [options]

Options:
  --database-url <url>      Reuse an existing PostgreSQL URL instead of npx create-db.
  --region <region>        Prisma Postgres create-db region. Default: ${DEFAULT_REGION}.
  --ttl <ttl>              Temporary DB lifetime. Default: ${DEFAULT_TTL}.
  --article-count <count>  Seeded article count. Default: ${DEFAULT_ARTICLE_COUNT}.
  --requests <count>       Measured requests per route. Default: ${DEFAULT_REQUESTS}.
  --concurrency <count>    Client concurrency. Default: ${DEFAULT_CONCURRENCY}.
  --repeat <count>         ORM operation repeat count per request. Default: ${DEFAULT_REPEAT}.
  --warmup-requests <n>    Unmeasured warmup requests per route. Default: ${DEFAULT_WARMUP_REQUESTS}.
  --workers <ids>          Comma-separated worker ids. Default: prisma-v7,drizzle-v1,prisma-next.
  --account-id <id>        Cloudflare account id. Defaults to CLOUDFLARE_ACCOUNT_ID.
  --keep-workers           Keep deployed Workers after the benchmark. Default: false.
  --output <dir>           Report output directory. Default: .tmp/cloudflare-benchmark/<run-id>.
`);
}

async function ensureDependencies() {
  if (args.has('no-install') || existsSync(path.join(ROOT_DIR, 'node_modules'))) return;
  await run('npm', ['install']);
}

async function checkWranglerAuth() {
  if (args.has('skip-wrangler-auth-check')) return;
  await run('npx', ['wrangler', 'whoami']);
}

async function createTemporaryDatabase() {
  const result = await run(
    'npx',
    ['create-db@latest', 'create', '--json', '--region', region, '--ttl', ttl],
    { silentOutput: true },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const data = parseJsonFromOutput(output);
  const databaseUrl = findPostgresUrl(data);
  const claimUrl = findString(data, (value) => value.startsWith('https://create-db.prisma.io'));

  if (!databaseUrl) {
    await writeFile(path.join(outputDir, 'create-db-output.log'), output);
    throw new Error(`Could not find a PostgreSQL connection string in create-db output.`);
  }

  await writeFile(
    path.join(outputDir, 'database.json'),
    JSON.stringify({ region, ttl, claimUrl: claimUrl ?? null }, null, 2),
  );

  return databaseUrl;
}

async function applySchema(databaseUrl) {
  const pg = await import('pg');
  const Client = pg.default?.Client ?? pg.Client;
  const schema = await readFile(path.join(ROOT_DIR, 'packages/db/schema.sql'), 'utf8');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(schema);
  } finally {
    await client.end();
  }
}

async function buildWorkers(ids, databaseUrl) {
  for (const workerId of ids) {
    const worker = WORKERS[workerId];
    if (!worker || !isRunnable(worker)) continue;

    if (worker.id === 'prisma-v7') {
      await run('npm', ['run', 'generate:prisma-v7'], { env: { DATABASE_URL: databaseUrl } });
    }

    await run('npm', ['run', worker.buildScript], { env: { DATABASE_URL: databaseUrl } });
  }
}

function isRunnable(worker) {
  if (worker.id !== 'prisma-next') return true;

  const packageJsonPath = path.join(ROOT_DIR, worker.packageJson);
  if (!existsSync(packageJsonPath)) return false;

  const packageJson = JSON.parse(readFileSyncUtf8(packageJsonPath));
  return Object.keys(packageJson.dependencies ?? {}).some((name) => name.startsWith('@prisma-next/'));
}

function readFileSyncUtf8(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

async function deployWorker(worker, databaseUrl, deployedWorkers) {
  const config = worker.config;
  const deployed = await run('npx', ['wrangler', 'deploy', '-c', config, '--keep-vars']);
  deployedWorkers.push(worker);
  await run('npx', ['wrangler', 'secret', 'put', 'DATABASE_URL', '-c', config], {
    input: `${databaseUrl}\n`,
  });

  const url = extractWorkerUrl(`${deployed.stdout}\n${deployed.stderr}`);
  if (!url) {
    throw new Error(`Could not find deployed workers.dev URL for ${worker.id}.`);
  }

  await waitForHealth(url);
  return { url };
}

async function cleanupWorkers(workers) {
  for (const worker of workers.toReversed()) {
    await run('npx', ['wrangler', 'delete', worker.name, '--force'], { allowFailure: true });
  }
}

async function waitForHealth(baseUrl) {
  const healthUrl = new URL('/health', baseUrl);
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
      lastError = new Error(`${response.status} ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  throw lastError ?? new Error(`Health check failed for ${baseUrl}`);
}

async function benchmarkWorker(worker, baseUrl) {
  const tail = startTail(worker.name);
  await sleep(tailWarmupMs);

  const results = [];
  try {
    for (const route of DEFAULT_ROUTES) {
      const url = new URL(route.path, baseUrl);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('repeat', String(repeat));
      url.searchParams.set('benchRun', runId);
      url.searchParams.set('benchWorker', worker.id);
      url.searchParams.set('benchRoute', route.id);
      for (const [key, value] of Object.entries(route.params ?? {})) {
        url.searchParams.set(key, value);
      }

      const warmupUrl = new URL(url);
      warmupUrl.searchParams.set('benchPhase', 'warmup');
      await loadTest(
        warmupUrl.toString(),
        warmupRequests,
        Math.min(concurrency, warmupRequests),
      );
      await sleep(tailSettleMs);

      url.searchParams.set('benchPhase', 'measure');
      const startedEventIndex = tail.events.length;
      const latency = await loadTest(url.toString());
      await sleep(tailSettleMs);
      const routeEvents = tail.events
        .slice(startedEventIndex)
        .filter((event) => eventMatches(event, route.id, 'measure'));
      const cpuValues = routeEvents.map((event) => findMetric(event, 'cpu')).filter(isFiniteNumber);
      const wallValues = routeEvents.map((event) => findMetric(event, 'wall')).filter(isFiniteNumber);

      results.push({
        id: route.id,
        path: `${route.path}`,
        url: url.toString(),
        latency,
        tailEvents: routeEvents.length,
        cpuTime: summarize(cpuValues),
        wallTime: summarize(wallValues),
      });
    }
  } finally {
    await tail.stop();
    await writeFile(
      path.join(outputDir, `${worker.id}-tail.jsonl`),
      tail.events.map((event) => JSON.stringify(event)).join('\n'),
    );
  }

  return results;
}

function startTail(workerName) {
  const child = spawn(
    'npx',
    ['wrangler', 'tail', workerName, '--format', 'json', '--sampling-rate', '0.999', '--status', 'ok'],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...(cloudflareAccountId ? { CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId } : {}),
      },
    },
  );
  const events = [];
  const parser = createJsonObjectParser((event) => events.push(event));

  child.stdout.on('data', (chunk) => {
    parser.write(chunk.toString());
  });

  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  return {
    events,
    async stop() {
      parser.flush();
      child.kill('SIGINT');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3_000).then(() => child.kill('SIGTERM')),
      ]);
      parser.flush();
    },
  };
}

function createJsonObjectParser(onValue) {
  let buffer = '';
  let depth = 0;
  let collecting = false;
  let inString = false;
  let escaped = false;

  function reset() {
    buffer = '';
    depth = 0;
    collecting = false;
    inString = false;
    escaped = false;
  }

  function parseBuffer() {
    try {
      onValue(JSON.parse(buffer));
    } catch {
      // Wrangler may write progress text around JSON objects; ignore malformed fragments.
    }
    reset();
  }

  return {
    write(text) {
      for (const char of text) {
        if (!collecting) {
          if (char === '{') {
            collecting = true;
            buffer = char;
            depth = 1;
          }
          continue;
        }

        buffer += char;

        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === '\\' && inString) {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (char === '{') {
          depth += 1;
          continue;
        }

        if (char === '}') {
          depth -= 1;
          if (depth === 0) parseBuffer();
        }
      }
    },
    flush() {
      if (collecting && depth === 0 && buffer.trim()) parseBuffer();
    },
  };
}

async function loadTest(url, requestCount = requests, concurrencyCount = concurrency) {
  const latencies = [];
  let next = 0;
  let errors = 0;

  async function runWorker() {
    while (next < requestCount) {
      next += 1;
      const started = performance.now();
      const response = await fetch(url);
      const elapsed = performance.now() - started;
      latencies.push(elapsed);
      if (!response.ok) {
        errors += 1;
        await response.arrayBuffer();
        continue;
      }
      await response.arrayBuffer();
    }
  }

  await Promise.all(Array.from({ length: concurrencyCount }, () => runWorker()));
  latencies.sort((a, b) => a - b);

  return {
    requests: requestCount,
    concurrency: concurrencyCount,
    errors,
    minMs: latencies[0] ?? null,
    p50Ms: pick(latencies, 0.5),
    p95Ms: pick(latencies, 0.95),
    p99Ms: pick(latencies, 0.99),
    maxMs: latencies.at(-1) ?? null,
  };
}

async function writeReport(report) {
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(redactReport(report), null, 2));
  await writeFile(path.join(outputDir, 'report.md'), formatMarkdownReport(report));
}

function formatMarkdownReport(report) {
  const lines = [
    '# Cloudflare Worker CPU benchmark',
    '',
    `Run ID: \`${report.runId}\``,
    `Created at: \`${report.createdAt}\``,
    `Database source: \`${report.database.source}\``,
    `Articles: \`${report.database.articleCount}\``,
    `Measured requests per route: \`${report.benchmark.requests}\``,
    `Concurrency: \`${report.benchmark.concurrency}\``,
    `Repeat per request: \`${report.benchmark.repeat}\``,
    `Warmup requests per route: \`${report.benchmark.warmupRequests}\``,
    '',
    '| Worker | Route | Tail events | CPU p50 | CPU p95 | Wall p50 | Wall p95 | Latency p95 | Errors |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const worker of report.workers) {
    if (worker.status !== 'completed') {
      lines.push(`| ${worker.id} | skipped: ${worker.reason} | 0 | | | | | | |`);
      continue;
    }

    for (const route of worker.routes) {
      lines.push(
        [
          worker.id,
          route.id,
          route.tailEvents,
          formatNumber(route.cpuTime.p50),
          formatNumber(route.cpuTime.p95),
          formatNumber(route.wallTime.p50),
          formatNumber(route.wallTime.p95),
          formatNumber(route.latency.p95Ms),
          route.latency.errors,
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
      );
    }
  }

  const comparisons = buildComparisons(report);
  if (comparisons.length) {
    lines.push('');
    lines.push('## Prisma v7 vs Drizzle v1');
    lines.push('');
    lines.push('| Route | Prisma CPU p50 | Drizzle CPU p50 | p50 ratio | Prisma CPU p95 | Drizzle CPU p95 | p95 ratio |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const comparison of comparisons) {
      lines.push(
        [
          comparison.route,
          formatNumber(comparison.prismaP50),
          formatNumber(comparison.drizzleP50),
          formatRatio(comparison.p50Ratio),
          formatNumber(comparison.prismaP95),
          formatNumber(comparison.drizzleP95),
          formatRatio(comparison.p95Ratio),
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
      );
    }
  }

  lines.push('');
  lines.push('CPU and wall values come from `wrangler tail --format json`, not local timing.');
  lines.push(`Benchmark Workers deleted after run: \`${report.cleanup.workersDeleted}\`.`);
  lines.push(`Database cleanup: ${report.cleanup.database}.`);
  return `${lines.join('\n')}\n`;
}

function buildComparisons(report) {
  const prisma = report.workers.find((worker) => worker.id === 'prisma-v7' && worker.status === 'completed');
  const drizzle = report.workers.find((worker) => worker.id === 'drizzle-v1' && worker.status === 'completed');
  if (!prisma || !drizzle) return [];

  const drizzleByRoute = new Map(drizzle.routes.map((route) => [route.id, route]));
  return prisma.routes.flatMap((prismaRoute) => {
    const drizzleRoute = drizzleByRoute.get(prismaRoute.id);
    if (!drizzleRoute) return [];

    const prismaP50 = prismaRoute.cpuTime.p50;
    const drizzleP50 = drizzleRoute.cpuTime.p50;
    const prismaP95 = prismaRoute.cpuTime.p95;
    const drizzleP95 = drizzleRoute.cpuTime.p95;

    return {
      route: prismaRoute.id,
      prismaP50,
      drizzleP50,
      p50Ratio: ratio(prismaP50, drizzleP50),
      prismaP95,
      drizzleP95,
      p95Ratio: ratio(prismaP95, drizzleP95),
    };
  });
}

function redactReport(report) {
  return report;
}

async function run(command, commandArgs, options = {}) {
  const env = {
    ...process.env,
    ...(cloudflareAccountId ? { CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId } : {}),
    ...(options.env ?? {}),
  };
  const child = spawn(command, commandArgs, {
    cwd: options.cwd ?? ROOT_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  if (options.input) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (!options.silentOutput) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (!options.silentOutput) process.stderr.write(chunk);
  });

  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`);
  }

  return { stdout, stderr, code };
}

function parseJsonFromOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in output.');
    return JSON.parse(output.slice(start, end + 1));
  }
}

function findPostgresUrl(value) {
  return findString(value, (entry) => /^postgres(ql)?:\/\//.test(entry));
}

function findString(value, predicate) {
  if (typeof value === 'string') return predicate(value) ? value : void 0;
  if (!value || typeof value !== 'object') return void 0;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findString(nested, predicate);
    if (found) return found;
  }
  return void 0;
}

function extractWorkerUrl(output) {
  return output.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/)?.[0];
}

function eventMatches(event, routeId, phase) {
  const requestUrl = event?.event?.request?.url;
  if (typeof requestUrl === 'string') {
    const params = new URL(requestUrl).searchParams;
    return params.get('benchRoute') === routeId && params.get('benchPhase') === phase;
  }

  const text = JSON.stringify(event);
  return text.includes(`benchRoute=${routeId}`) && text.includes(`benchPhase=${phase}`);
}

function findMetric(event, kind) {
  const matches = [];
  walk(event, (key, value) => {
    if (!isFiniteNumber(value)) return;

    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (kind === 'cpu' && ['cputime', 'cputimems', 'cpums'].includes(normalized)) {
      matches.push(value);
    }
    if (kind === 'wall' && ['walltime', 'walltimems', 'wallms'].includes(normalized)) {
      matches.push(value);
    }
  });
  return matches[0];
}

function walk(value, visitor) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visitor);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    visitor(key, nested);
    walk(nested, visitor);
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function summarize(values) {
  if (!values.length) {
    return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, avg: null };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: pick(sorted, 0.5),
    p95: pick(sorted, 0.95),
    p99: pick(sorted, 0.99),
    max: sorted.at(-1),
    avg: total / sorted.length,
  };
}

function pick(values, p) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

function formatNumber(value) {
  return value === null || value === void 0 ? '' : Number(value).toFixed(2);
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function formatRatio(value) {
  return value === null || value === void 0 ? '' : `${Number(value).toFixed(2)}x`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
