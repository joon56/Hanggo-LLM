// @vitest-environment node
import { expect, it } from 'vitest';
import { encodeWav } from '../../../src/call/speech-windows.ts';
import { createStubSpeech, STUB_TEXT } from './stub.ts';

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
it('reads the next line of each speaker when given a script, and marks it as test output', async () => {
  const scripted = createStubSpeech([{ speaker: 'trainer', text: '안녕하세요' }, { speaker: 'guardian', text: '초인종에 짖어요' }, { speaker: 'trainer', text: '매트로 보내 주세요' }]);
  await expect(scripted.transcribe(tone(880))).resolves.toMatchObject({ text: '[시험 전사] 안녕하세요' });
  await expect(scripted.transcribe(tone(440))).resolves.toMatchObject({ text: '[시험 전사] 초인종에 짖어요' });
  await expect(scripted.transcribe(tone(880))).resolves.toMatchObject({ text: '[시험 전사] 매트로 보내 주세요' });
});
