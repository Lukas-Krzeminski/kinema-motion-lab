/**
 * Per-stage clip recording.
 *
 * Records the RAW getUserMedia stream, not the overlay canvas, so the render
 * phase gets clean frames to segment and composite. Clips live as in-memory
 * Blobs and are never uploaded -- the consent copy says so and means it.
 */

import { CAPTURE } from '../config.js';

/**
 * Pick a MIME type the stream can actually be recorded as.
 *
 * isTypeSupported() answers "is this a valid type", NOT "can this stream be
 * recorded as it". Asking for an opus codec on a video-only stream passes the
 * support check and then throws NotSupportedError at construction -- which is
 * exactly what froze the capture screen. So candidates carrying an audio codec
 * are filtered out when the stream has no audio track.
 */
function pickMimeType(stream) {
  const hasAudio = (stream?.getAudioTracks?.() ?? []).length > 0;
  const hasVideo = (stream?.getVideoTracks?.() ?? []).length > 0;

  return CAPTURE.MIME_CANDIDATES.filter((type) => {
    const codecs = /codecs=([^;]+)/.exec(type)?.[1]?.split(',') ?? [];
    const wantsAudio = codecs.some((c) => /opus|vorbis|aac|mp4a/i.test(c));
    const wantsVideo = codecs.some((c) => /vp8|vp9|av01|h264|avc/i.test(c));
    if (wantsAudio && !hasAudio) return false;
    if (wantsVideo && !hasVideo) return false;
    return MediaRecorder.isTypeSupported(type);
  })[0] ?? '';
}

/**
 * Construct a recorder, degrading through progressively plainer options.
 * Returns null rather than throwing -- a recorder that cannot be built must
 * never take the tracking loop down with it.
 */
function construct(stream, mimeType) {
  const attempts = [
    mimeType ? { mimeType, videoBitsPerSecond: CAPTURE.VIDEO_BITS_PER_SECOND } : null,
    mimeType ? { mimeType } : null,
    { videoBitsPerSecond: CAPTURE.VIDEO_BITS_PER_SECOND },
    undefined,
  ].filter((v) => v !== null);

  for (const options of attempts) {
    try {
      return new MediaRecorder(stream, options);
    } catch {
      // try the next, plainer, configuration
    }
  }
  return null;
}

export function createClipRecorder(stream) {
  const mimeType = pickMimeType(stream);
  /** @type {Array<{id:string, stage:number, blob:Blob, url:string, durationMs:number}>} */
  const clips = [];

  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let bytes = 0;
  /** Set if the browser refuses to give us a recorder at all. */
  let failure = null;

  const start = () => {
    if (recorder?.state === 'recording') return true;
    chunks = [];
    bytes = 0;

    recorder = construct(stream, mimeType);
    if (!recorder) {
      failure = 'MediaRecorder unavailable for this stream';
      return false;
    }

    recorder.ondataavailable = (e) => {
      if (e.data?.size) { chunks.push(e.data); bytes += e.data.size; }
    };
    recorder.onerror = (e) => { failure = e?.error?.message ?? 'recorder error'; };

    try {
      // Timeslice keeps chunks flowing so a crash mid-stage still leaves data.
      recorder.start(250);
    } catch (err) {
      failure = err?.message ?? 'recorder refused to start';
      recorder = null;
      return false;
    }

    startedAt = performance.now();
    failure = null;
    return true;
  };

  /**
   * Stops and banks the clip. Resolves once the recorder has flushed, which
   * is asynchronous -- awaiting it is what guarantees a complete blob.
   */
  const stop = (meta = {}) => new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') return resolve(null);
    const durationMs = performance.now() - startedAt;
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const clip = {
        id: `clip-${clips.length + 1}`,
        stage: meta.stage ?? clips.length + 1,
        blob,
        url: URL.createObjectURL(blob),
        durationMs,
      };
      clips.push(clip);
      chunks = [];
      recorder = null;
      resolve(clip);
    };
    try {
      recorder.stop();
    } catch {
      recorder = null;
      resolve(null);
    }
  });

  return {
    mimeType,
    start,
    stop,
    /** Let the clip run a beat past the pass so it has a tail to play out. */
    stopAfterTail: (meta) =>
      new Promise((resolve) => setTimeout(() => stop(meta).then(resolve), CAPTURE.TAIL_MS)),
    get clips() { return clips; },
    get isRecording() { return recorder?.state === 'recording'; },
    /** Live state for the HUD, so "is it recording?" is answerable at a glance. */
    get state() { return failure ? 'FAILED' : (recorder?.state ?? 'idle').toUpperCase(); },
    get failure() { return failure; },
    /** Bytes banked so far in the current clip. */
    get liveBytes() { return bytes; },
    totalBytes: () => clips.reduce((n, c) => n + c.blob.size, 0),
    totalMs: () => clips.reduce((n, c) => n + c.durationMs, 0),
    /** Revoke every object URL and drop the blobs. Wired to "Clear session data". */
    dispose() {
      for (const c of clips) URL.revokeObjectURL(c.url);
      clips.length = 0;
    },
  };
}
