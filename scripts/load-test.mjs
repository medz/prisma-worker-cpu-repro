import { performance } from 'node:perf_hooks';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const url = args.get('--url');
const requests = Number(args.get('--requests') ?? 100);
const concurrency = Number(args.get('--concurrency') ?? 10);

if (!url) {
  throw new Error('Usage: npm run bench -- --url <url> [--requests 100] [--concurrency 10]');
}

const latencies = [];
let next = 0;
let errors = 0;

async function worker() {
  while (next < requests) {
    next += 1;
    const started = performance.now();
    const response = await fetch(url);
    const elapsed = performance.now() - started;
    latencies.push(elapsed);
    if (!response.ok) {
      errors += 1;
      console.error(await response.text());
      continue;
    }
    await response.arrayBuffer();
  }
}

await Promise.all(
  Array.from({ length: concurrency }, () => worker()),
);

latencies.sort((a, b) => a - b);
const pick = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];

console.log(
  JSON.stringify(
    {
      url,
      requests,
      concurrency,
      errors,
      minMs: latencies[0],
      p50Ms: pick(0.5),
      p95Ms: pick(0.95),
      p99Ms: pick(0.99),
      maxMs: latencies.at(-1),
    },
    null,
    2,
  ),
);

