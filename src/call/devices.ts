export type DevicePreference = { camera?: boolean; microphone?: boolean; cameraId?: string; microphoneId?: string; facingMode?: 'user' | 'environment' };
export type MissingReason = 'denied' | 'not-found' | 'busy' | 'unsupported' | 'failed';
export type MissingDevice = { device: 'camera' | 'microphone'; reason: MissingReason };
type MediaSource = Pick<MediaDevices, 'getUserMedia'> | undefined;

function reasonOf(error: unknown): MissingReason {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not-found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}

function constraintsFor(preference: DevicePreference) {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(preference.microphoneId ? { deviceId: { exact: preference.microphoneId } } : {}) };
  const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 },
    ...(preference.cameraId ? { deviceId: { exact: preference.cameraId } } : preference.facingMode ? { facingMode: { ideal: preference.facingMode } } : {}) };
  return { audio, video };
}

/** A person without a camera or microphone can still join and watch, so a failure narrows the call instead of ending it. */
export async function openDevices(preference: DevicePreference, media: MediaSource = navigator.mediaDevices,
  createStream: () => MediaStream = () => new MediaStream()): Promise<{ stream: MediaStream; missing: MissingDevice[] }> {
  const wantMicrophone = preference.microphone !== false; const wantCamera = preference.camera !== false;
  const wanted = (reason: MissingReason) => [...(wantMicrophone ? [{ device: 'microphone' as const, reason }] : []), ...(wantCamera ? [{ device: 'camera' as const, reason }] : [])];
  if (!media?.getUserMedia) return { stream: createStream(), missing: wanted('unsupported') };
  if (!wantMicrophone && !wantCamera) return { stream: createStream(), missing: [] };
  const { audio, video } = constraintsFor(preference);
  const request = wantMicrophone && wantCamera ? { audio, video } : wantMicrophone ? { audio, video: false } : { audio: false, video };
  try { return { stream: await media.getUserMedia(request), missing: [] }; }
  catch (error) {
    if (!(wantMicrophone && wantCamera)) return { stream: createStream(), missing: wanted(reasonOf(error)) };
    const bothReason = reasonOf(error);
    const audioOnly = await media.getUserMedia({ audio, video: false }).catch(cause => cause as unknown);
    if (!(audioOnly instanceof Error) && !(audioOnly instanceof DOMException)) return { stream: audioOnly as MediaStream, missing: [{ device: 'camera', reason: bothReason }] };
    const videoOnly = await media.getUserMedia({ audio: false, video }).catch(cause => cause as unknown);
    if (!(videoOnly instanceof Error) && !(videoOnly instanceof DOMException)) return { stream: videoOnly as MediaStream, missing: [{ device: 'microphone', reason: reasonOf(audioOnly) }] };
    return { stream: createStream(), missing: [{ device: 'microphone', reason: reasonOf(audioOnly) }, { device: 'camera', reason: reasonOf(videoOnly) }] };
  }
}
