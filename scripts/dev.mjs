import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientArgs = ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort'];
const appUrl = 'http://127.0.0.1:5173/';

function launch(args) {
  return spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
}

async function available() {
  try { return (await fetch(appUrl, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}

// Playwright global setup. All browser API calls are mocked in the specs.
// A direct child handle lets teardown work on Windows where taskkill may be denied.
export default async function setupBrowserTests() {
  if (await available()) return;
  const client = launch(clientArgs);
  let startupError;
  client.once('error', error => { startupError = error; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (client.exitCode !== null) throw new Error(`Browser test server exited (${client.exitCode}).`);
    if (await available()) {
      return async () => {
        if (client.exitCode !== null) return;
        const exit = once(client, 'exit');
        client.kill();
        await exit;
      };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  client.kill();
  throw new Error(`Browser test server did not start at ${appUrl}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const children = [launch(['--env-file-if-exists=.env', 'server/index.ts']), launch(clientArgs)];
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill();
    process.exitCode = code;
  }
  for (const child of children) {
    child.once('error', error => { console.error(error.message); stop(1); });
    child.once('exit', code => { if (!stopping) stop(code ?? 1); });
  }
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  await Promise.allSettled(children.map(child => once(child, 'exit')));
}
