// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';

it('serves the built app from a workspace beneath a hidden directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), '.hanggo-static-'));
  try {
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist', 'index.html'), '<html><body>Local consultation</body></html>');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    let app;
    try { app = createApp(readConfig({}), { generate: async () => ({}), transcribe: async () => '' }); }
    finally { cwd.mockRestore(); }
    const response = await request(app).get('/').expect(200);
    expect(response.text).toContain('Local consultation');
    // A link cut short should reach the app, which can explain it, rather than a bare "Cannot GET".
    for (const cut of ['/join', '/join/', '/Join']) expect((await request(app).get(cut).expect(200)).text, cut).toContain('Local consultation');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
