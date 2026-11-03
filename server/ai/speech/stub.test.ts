// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../../src/call/speech-windows.ts';
import { createStubSpeech, scriptTone, STUB_TEXT, type StubScript } from './stub.ts';

const tone = (frequency: number, amplitude = 0.1) => Buffer.from(encodeWav(Float32Array.from({ length: 16000 }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * index / 16000))));
const speech = createStubSpeech();

it('names the microphone by its test tone so tests can prove speakers are not swapped', async () => {
  await expect(speech.transcribe(tone(440))).resolves.toMatchObject({ text: STUB_TEXT.guardian, model: 'stub' });
  await expect(speech.transcribe(tone(880))).resolves.toMatchObject({ text: STUB_TEXT.trainer, model: 'stub' });
});
it('keeps recognizing a tone that processing made much quieter', async () => {
  await expect(speech.transcribe(tone(440, 0.005))).resolves.toMatchObject({ text: STUB_TEXT.guardian });
});
it('ignores silent stretches when measuring the tone', async () => {
  const silence = Buffer.from(encodeWav(new Float32Array(16000)));
  const mixed = Buffer.concat([silence, tone(880).subarray(44)]);
  mixed.writeUInt32LE(mixed.length - 8, 4); mixed.writeUInt32LE(mixed.length - 44, 40);
  await expect(speech.transcribe(mixed)).resolves.toMatchObject({ text: STUB_TEXT.trainer });
});
it('says so rather than guessing a speaker for anything else', async () => {
  await expect(speech.transcribe(tone(200))).resolves.toMatchObject({ text: STUB_TEXT.unknown });
});
describe('with a script', () => {
  const script: StubScript = [{ speaker: 'trainer', text: '안녕하세요' }, { speaker: 'guardian', text: '초인종에 짖어요' }, { speaker: 'trainer', text: '매트로 보내 주세요' }];
  const speak = (speaker: 'guardian' | 'trainer', line: number) => tone(scriptTone(speaker, line));
  it('reads the line its tone stands for, and marks it as test output', async () => {
    const scripted = createStubSpeech(script);
    await expect(scripted.transcribe(speak('trainer', 0))).resolves.toMatchObject({ text: '[시험 전사] 안녕하세요' });
    await expect(scripted.transcribe(speak('guardian', 0))).resolves.toMatchObject({ text: '[시험 전사] 초인종에 짖어요' });
    await expect(scripted.transcribe(speak('trainer', 1))).resolves.toMatchObject({ text: '[시험 전사] 매트로 보내 주세요' });
  });
  it('still finds the line when audio processing shifts the pitch a little, as it does on a CI machine', async () => {
    const scripted = createStubSpeech([...script, { speaker: 'trainer', text: '세 번째 줄' }]);
    await expect(scripted.transcribe(tone(scriptTone('trainer', 1) * 0.97))).resolves.toMatchObject({ text: '[시험 전사] 매트로 보내 주세요' });
    await expect(scripted.transcribe(tone(scriptTone('trainer', 2) * 1.03))).resolves.toMatchObject({ text: '[시험 전사] 세 번째 줄' });
    await expect(scripted.transcribe(tone(scriptTone('guardian', 0) * 0.97))).resolves.toMatchObject({ text: '[시험 전사] 초인종에 짖어요' });
  });
  it('stays on the right line when a window is lost or a tone is cut in two', async () => {
    const scripted = createStubSpeech(script);
    await expect(scripted.transcribe(speak('trainer', 1))).resolves.toMatchObject({ text: '[시험 전사] 매트로 보내 주세요' });
    await expect(scripted.transcribe(speak('trainer', 1))).resolves.toMatchObject({ text: '' });
  });
  it('still tells a test tone it has no line for from a speaker', async () => {
    await expect(createStubSpeech(script).transcribe(tone(200))).resolves.toMatchObject({ text: STUB_TEXT.unknown });
    await expect(createStubSpeech(script).transcribe(speak('guardian', 5))).resolves.toMatchObject({ text: STUB_TEXT.guardian });
  });
});
