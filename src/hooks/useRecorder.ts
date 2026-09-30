import { useCallback, useEffect, useRef, useState } from 'react';

type Status = 'idle' | 'requesting' | 'recording' | 'ready';

export function useRecorder() {
  const [status, setStatus] = useState<Status>('idle');
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const url = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const startedAt = useRef(0);

  const releaseTracks = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
  }, []);

  const dispose = useCallback(() => {
    generation.current += 1;
    const active = recorder.current;
    if (active) {
      active.onstop = null;
      active.ondataavailable = null;
      active.onerror = null;
      if (active.state !== 'inactive') active.stop();
    }
    recorder.current = null;
    releaseTracks();
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  }, [releaseTracks]);

  const reset = useCallback(() => {
    dispose();
    setAudioUrl(null);
    setAudioBlob(null);
    setDuration(0);
    setError('');
    setStatus('idle');
  }, [dispose]);

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    reset();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('이 환경에서는 녹음을 지원하지 않습니다. localhost 또는 HTTPS에서 열거나 텍스트로 입력해 주세요.');
      return;
    }
    const attempt = generation.current;
    setStatus('requesting');
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || attempt !== generation.current) {
        acquired.getTracks().forEach(track => track.stop());
        return;
      }
      stream.current = acquired;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(acquired, mimeType ? { mimeType } : undefined);
      recorder.current = active;
      const chunks: Blob[] = [];
      active.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data);
      };
      active.onstop = () => {
        releaseTracks();
        recorder.current = null;
        if (!mounted.current || attempt !== generation.current) return;
        const seconds = Math.min(60, (Date.now() - startedAt.current) / 1000);
        setDuration(Math.floor(seconds));
        if (seconds < 3 || !chunks.length) {
          setStatus('idle');
          setError('3초 이상 녹음해 주세요. 짧은 내용은 텍스트로도 입력할 수 있습니다.');
          return;
        }
        const blob = new Blob(chunks, { type: active.mimeType || 'audio/webm' });
        if (blob.size > 10 * 1024 * 1024) {
          setStatus('idle');
          setError('녹음은 10MB 이하로 남겨 주세요.');
          return;
        }
        url.current = URL.createObjectURL(blob);
        setAudioBlob(blob);
        setAudioUrl(url.current);
        setStatus('ready');
      };
      active.onerror = () => {
        reset();
        setError('녹음을 완료하지 못했습니다. 다시 녹음하거나 텍스트로 입력해 주세요.');
      };
      startedAt.current = Date.now();
      active.start(500);
      setStatus('recording');
      timer.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt.current) / 1000);
        if (mounted.current) setDuration(Math.min(seconds, 60));
        if (seconds >= 60) stop();
      }, 250);
    } catch {
      if (!mounted.current || attempt !== generation.current) return;
      dispose();
      setStatus('idle');
      setError('마이크를 사용할 수 없습니다. 브라우저 권한을 확인하거나 텍스트로 입력해 주세요.');
    }
  }, [reset, releaseTracks, stop, dispose]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; dispose(); };
  }, [dispose]);

  return { status, duration, audioUrl, audioBlob, error, start, stop, reset };
}
