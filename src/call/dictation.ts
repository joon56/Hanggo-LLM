import { SpeechWindows } from './speech-windows';
import { tapMicrophone } from './media-tools';

const MAX_DICTATION_MS = 60_000;
type Options = {
  transcribe: (bytes: Blob, order: number) => Promise<string>;
  onText: (text: string) => void;
  onError: (error: unknown) => void;
  onStopped: () => void;
  openMicrophone?: () => Promise<MediaStream>;
};

/** Short voice notes for a guardian's records. Audio goes through the same windows as a call and is not kept. */
export async function startDictation({ transcribe, onText, onError, onStopped, openMicrophone = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) }: Options) {
  const stream = await openMicrophone();
  let order = 0;
  // Windows finish in speaking order, and text must come back in that order however long each request takes.
  let tail: Promise<unknown> = Promise.resolve();
  const send = (bytes: Blob) => {
    const current = order++;
    const text = transcribe(bytes, current);
    tail = tail.then(() => text).then(result => { if (result) onText(result); }, onError);
  };
  let windows: SpeechWindows | undefined;
  const tap = await tapMicrophone(stream.getAudioTracks()[0], samples => windows?.push(samples));
  windows = new SpeechWindows(tap.sampleRate, window => send(window.bytes));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(limit);
    tap.stop();
    stream.getTracks().forEach(track => track.stop());
    windows?.flush();
    void tail.finally(onStopped);
  };
  const limit = setTimeout(stop, MAX_DICTATION_MS);
  return { stop };
}
