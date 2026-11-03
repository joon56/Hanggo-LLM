import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Downloads what the CPU-only real model run needs into HANGGO_HOME, checking every file against its known hash.
// Runs on Linux in GitHub Actions. On Windows the setup scripts install the GPU runtime instead.
const RUNTIME = {
  id: 'runtime-llama-cpp-linux-cpu', dest: 'runtime/llama-cpp/llama.tar.gz', size: 0, extract: true,
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12069/llama-b12069-bin-ubuntu-x64.tar.gz',
  sha256: '70df3ef8becd405b9ebc13b925387715ae7dccb0f034fd5f46a4034b350130a1',
};
const MODEL_IDS = ['stt-qwen-asr', 'stt-qwen-asr-mmproj', 'llm-qwen35-4b-ci'];
type Item = { id: string; url: string; sha256: string; dest: string; extract?: boolean | string };

const home = process.env.HANGGO_HOME;
if (!home) throw new Error('Set HANGGO_HOME.');
const manifest = JSON.parse(readFileSync(new URL('./models.manifest.json', import.meta.url), 'utf8')) as Item[];
const items: Item[] = [RUNTIME, ...MODEL_IDS.map(id => manifest.find(item => item.id === id)!)];

async function sha256Of(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of (await import('node:fs')).createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download({ id, url, sha256, dest }: Item) {
  const target = path.join(home!, dest);
  if (existsSync(target) && await sha256Of(target) === sha256) { console.info(`${id}: already present`); return target; }
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${id}: download failed (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
  const actual = await sha256Of(partial);
  if (actual !== sha256) { await rm(partial, { force: true }); throw new Error(`${id}: hash mismatch.`); }
  await rename(partial, target);
  console.info(`${id}: ${(statSync(target).size / 1e6).toFixed(0)}MB`);
  return target;
}

function find(folder: string, name: string): string | undefined {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) { const nested = find(full, name); if (nested) return nested; }
  }
  return undefined;
}

for (const item of items) {
  const file = await download(item);
  if (item.extract === true) execFileSync('tar', ['-xzf', file, '-C', path.dirname(file)]);
}
const server = find(path.join(home, 'runtime', 'llama-cpp'), 'llama-server');
if (!server) throw new Error('llama-server was not in the archive.');
console.info(`llama-server: ${server}`);
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `LLAMA_SERVER=${server}\n`);
