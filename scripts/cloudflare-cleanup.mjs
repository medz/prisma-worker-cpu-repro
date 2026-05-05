import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKERS = {
  'prisma-v7': 'prisma-worker-cpu-prisma-v7',
  'drizzle-v1': 'prisma-worker-cpu-drizzle-v1',
  'prisma-next': 'prisma-worker-cpu-prisma-next',
};
const args = parseArgs(process.argv.slice(2));
const workerIds = (args.get('workers') ?? Object.keys(WORKERS).join(','))
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const accountId = args.get('account-id') ?? process.env.CLOUDFLARE_ACCOUNT_ID;

for (const workerId of workerIds) {
  const name = WORKERS[workerId] ?? workerId;
  await run('npx', ['wrangler', 'delete', name, '--force'], { allowFailure: true });
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

async function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  const output = `${stdout}${stderr}`;
  if (code !== 0 && output.includes('[code: 10090]')) {
    console.log(`${commandArgs[2]} already absent`);
    return;
  }

  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`);
  }
}
