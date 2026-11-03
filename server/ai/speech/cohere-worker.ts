import { OutputRepetition, TranscribeModel } from 'transcribe-cpp';
import { runCohere } from './cohere-transcribe.ts';
import { wavToPcm } from './wav.ts';

// Runs in its own process so a native crash cannot take the server or the call down with it.
const send = (message: unknown) => process.send!(message);
const reason = (error: unknown) => error instanceof Error ? error.message : 'Speech worker failed.';
let model: Awaited<ReturnType<typeof TranscribeModel.load>>;
try {
  model = await TranscribeModel.load(process.env.HANGGO_STT_MODEL!);
  send({ type: 'ready' });
} catch (error) {
  send({ type: 'load-failed', message: reason(error) });
  process.exit(1);
}
process.on('message', async (message: { type: 'transcribe'; id: number; wav: Uint8Array }) => {
  try {
    const text = await runCohere(model, wavToPcm(Buffer.from(message.wav)), OutputRepetition);
    send({ type: 'result', id: message.id, text });
  } catch (error) {
    send({ type: 'failure', id: message.id, message: reason(error) });
  }
});
process.on('disconnect', () => process.exit(0));
