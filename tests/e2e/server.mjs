import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const mode = process.env.MOCK_DATA_MODE === 'populated' ? 'populated' : 'empty';
const env = {
  ...process.env,
  MOCK_DATA_MODE: mode,
  SUPABASE_STUB_PORT: '54321',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'e2e-only-public-anon-key',
  TRACK_CLAN: 'Alpha',
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: fileURLToPath(new URL('./mock-google-fonts.cjs', import.meta.url)),
  PORT: '3000',
};

const children = [];
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function start(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  children.push(child);
  return child;
}

function stopChildren() {
  for (const child of children) {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
}

async function waitForUrl(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Server process exited with code ${child.exitCode} before ${url} became ready.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(400);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'no successful response'}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = start(command, args);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? signal}`));
    });
  });
}

process.once('SIGINT', () => { stopChildren(); process.exit(130); });
process.once('SIGTERM', () => { stopChildren(); process.exit(143); });

try {
  const stub = start(process.execPath, ['tests/e2e/supabase-stub.mjs']);
  await waitForUrl('http://127.0.0.1:54321/health', stub);

  process.stdout.write(`Starting the app in ${process.env.E2E_DEV === '1' ? 'development' : 'production'} mode with ${mode} fixture data and no external database credentials.\n`);
  if (process.env.E2E_DEV === '1') {
    const next = start(npmCommand, ['run', 'dev', '--', '--hostname', '127.0.0.1']);
    await waitForUrl('http://127.0.0.1:3000', next, 120_000);
  } else {
    await run(npmCommand, ['run', 'build']);
    const next = start(npmCommand, ['run', 'start', '--', '--hostname', '127.0.0.1']);
    await waitForUrl('http://127.0.0.1:3000', next, 90_000);
  }
  process.stdout.write('Next.js browser-test server is ready.\n');
} catch (error) {
  stopChildren();
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
