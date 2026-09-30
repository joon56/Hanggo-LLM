import { afterEach, expect, it, vi } from 'vitest';
import { generateNote, transcribe, verifyAudibleAudio } from './api';

afterEach(() => vi.unstubAllGlobals());

it('sends explicit consent and same-origin cookies for text and audio', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  await generateNote('원문', 'trainer_summary_text');
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', method: 'POST', body: JSON.stringify({ text: '원문', sourceKind: 'trainer_summary_text', consent: true }) });
  await transcribe(new Blob(['sound'], { type: 'audio/webm' }), 4, '초코');
  const upload = fetchMock.mock.calls[1][1].body as FormData;
  expect(upload.get('consent')).toBe('true');
  expect(upload.get('duration')).toBe('4');
  expect((upload.get('audio') as File).name).toBe('recording.webm');
});

it('blocks silent audio before upload', async () => {
  class SilentAudioContext {
    decodeAudioData = vi.fn().mockResolvedValue({ numberOfChannels: 1, sampleRate: 10, getChannelData: () => new Float32Array(50) });
    close = vi.fn().mockResolvedValue(undefined);
  }
  vi.stubGlobal('AudioContext', SilentAudioContext);
  await expect(verifyAudibleAudio(new Blob(['audio']))).rejects.toMatchObject({ code: 'SILENT_AUDIO' });
});
