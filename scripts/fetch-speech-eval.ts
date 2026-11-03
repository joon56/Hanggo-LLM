import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadLocalEnv, readConfig } from '../server/config.ts';

// Prepares evaluation audio under HANGGO_HOME. Usage: node scripts/fetch-speech-eval.ts [zeroth sample count]
loadLocalEnv();
const config = readConfig();
const root = path.resolve(config.home, 'cache', 'eval');
const count = Number(process.argv[2] ?? 200);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function json(url: string) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (response.ok) return response.json();
    if (attempt >= 4) throw new Error(`Dataset request failed (${response.status}).`);
    await pause(2000 * (attempt + 1));
  }
}

async function zeroth() {
  const directory = path.join(root, 'zeroth');
  await mkdir(directory, { recursive: true });
  const samples: { file: string; expected: string }[] = [];
  for (let offset = 0; samples.length < count; offset += 100) {
    const page = await json(`https://datasets-server.huggingface.co/rows?dataset=kresnik%2Fzeroth_korean&config=default&split=test&offset=${offset}&length=100`);
    if (!page.rows?.length) break;
    for (const { row } of page.rows) {
      if (samples.length >= count) break;
      const file = `${row.id}.wav`;
      const target = path.join(directory, file);
      if (!existsSync(target)) {
        const audio = await fetch(row.audio[0].src, { signal: AbortSignal.timeout(60_000) });
        if (!audio.ok) throw new Error(`Audio download failed (${audio.status}).`);
        const source = `${target}.source`;
        await writeFile(source, Buffer.from(await audio.arrayBuffer()));
        execFileSync(config.ffmpegPath, ['-v', 'error', '-nostdin', '-y', '-i', source, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target], { windowsHide: true });
        await rm(source);
      }
      samples.push({ file, expected: row.text });
    }
    console.info(`zeroth: ${samples.length}/${count}`);
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ kind: 'human', source: 'kresnik/zeroth_korean test, read speech', samples }, null, 2));
}

async function domain() {
  const directory = path.join(root, 'domain');
  await mkdir(directory, { recursive: true });
  const sentences = JSON.parse(await readFile(new URL('../fixtures/speech-domain-sentences.json', import.meta.url), 'utf8')) as { id: string; text: string; terms: string[][] }[];
  const textFile = path.join(directory, 'sentences.txt');
  await writeFile(textFile, sentences.map(sentence => sentence.text).join('\n'), 'utf8');
  const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Speech;$format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);$i=0;foreach($line in [IO.File]::ReadAllLines('${textFile}',[Text.Encoding]::UTF8)){$i++;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.SelectVoice('Microsoft Heami Desktop');$s.SetOutputToWaveFile((Join-Path '${directory}' ('D{0:d2}.wav' -f $i)),$format);$s.Speak($line);$s.Dispose()}`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ kind: 'synthetic', source: 'fixtures/speech-domain-sentences.json, Microsoft Heami', samples: sentences.map(sentence => ({ file: `${sentence.id}.wav`, expected: sentence.text, terms: sentence.terms })) }, null, 2));
  console.info(`domain: ${sentences.length}`);
}

await domain();
await zeroth();
