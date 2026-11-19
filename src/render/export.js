/**
 * Exports the live composite to a real .webm file.
 *
 * Captures the compositor canvas and mixes in the audio graph's stream, so
 * the downloaded file carries the music as well as the visuals.
 */

import { CAPTURE } from '../config.js';

function pickMimeType() {
  for (const type of CAPTURE.MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * @param {HTMLCanvasElement} canvas compositor canvas
 * @param {MediaStream|null} audioStream from the audio engine
 */
export function createExporter(canvas, audioStream) {
  let recorder = null;
  let chunks = [];

  return {
    get isRecording() { return recorder?.state === 'recording'; },

    start(fps = 30) {
      if (recorder?.state === 'recording') return;
      const stream = canvas.captureStream(fps);
      for (const track of audioStream?.getAudioTracks() ?? []) {
        stream.addTrack(track);
      }
      chunks = [];
      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: CAPTURE.VIDEO_BITS_PER_SECOND,
      });
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.start(500);
    },

    /** @returns {Promise<{blob:Blob, url:string}|null>} */
    stop() {
      return new Promise((resolve) => {
        if (!recorder || recorder.state === 'inactive') return resolve(null);
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
          chunks = [];
          recorder = null;
          resolve({ blob, url: URL.createObjectURL(blob) });
        };
        recorder.stop();
      });
    },
  };
}

/** Triggers a browser download for a blob URL. */
export function downloadBlob(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
