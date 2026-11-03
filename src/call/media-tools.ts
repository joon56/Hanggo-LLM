import type { FrameGrabber, MicrophoneTap } from './call-recorder';

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;
const MAX_FRAME_BYTES = 256 * 1024;
const QUALITIES = [0.75, 0.5, 0.3];
const RESUME_TIMEOUT_MS = 4000;

let sharedContext: AudioContext | undefined;
let workletLoaded: Promise<void> | undefined;
function audioContext() {
  sharedContext ??= new AudioContext();
  return sharedContext;
}

/**
 * iOS only starts audio inside a tap, and recording starts later when the other person consents.
 * Call this from a click handler so the context is already running by then.
 */
export function unlockAudio() {
  if (typeof AudioContext !== 'undefined') void audioContext().resume().catch(() => {});
}

export async function tapMicrophone(track: MediaStreamTrack, onSamples: (samples: Float32Array) => void): Promise<MicrophoneTap> {
  const context = audioContext();
  workletLoaded ??= context.audioWorklet.addModule('/consultation-audio-worklet.js');
  await workletLoaded;
  // Waiting on resume() can hang forever without a gesture, and the failure should surface as a warning.
  await Promise.race([context.resume(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Audio did not start.')), RESUME_TIMEOUT_MS))]);
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const worklet = new AudioWorkletNode(context, 'consultation-audio');
  worklet.port.onmessage = event => { if (event.data.type === 'samples') onSamples(event.data.samples); };
  // Browsers only run nodes that lead to an output, so the graph ends in a muted one.
  const mute = context.createGain(); mute.gain.value = 0;
  source.connect(worklet); worklet.connect(mute); mute.connect(context.destination);
  return { sampleRate: context.sampleRate, stop() {
    worklet.port.onmessage = null;
    source.disconnect(); worklet.disconnect(); mute.disconnect();
  } };
}

/** Reads from a hidden element because mobile browsers stop drawing a video that is not in the page. */
export function createGrabber(stream: MediaStream): FrameGrabber {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
  video.srcObject = stream;
  document.body.append(video);
  void video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  return {
    async grab() {
      if (!stream.getVideoTracks()[0]?.enabled || !video.videoWidth) return null;
      const scale = Math.min(FRAME_WIDTH / video.videoWidth, FRAME_HEIGHT / video.videoHeight, 1);
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        const bytes = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (bytes && bytes.size <= MAX_FRAME_BYTES) return bytes;
      }
      return null;
    },
    close() { video.srcObject = null; video.remove(); },
  };
}
