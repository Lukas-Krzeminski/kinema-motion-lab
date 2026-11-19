/**
 * Boot sequence.
 *
 * Most of these lines report genuinely measured values -- real model byte
 * counts, the real WASM SIMD result, the real camera device name, the real
 * resolution the browser negotiated. That is what makes the panel read as an
 * actual tool rather than set dressing.
 */

import { APP } from '../config.js';
import { hasSimd, modelSize } from '../tracking/vision.js';
import { assetSource } from '../tracking/mediapipe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Cross-origin HEAD requests do not expose content-length unless the host
 * opts in, so a CDN load legitimately reports zero. Showing "0.0 MB" would
 * look like a failure, so fall back to naming the source instead.
 */
const mb = (bytes) => (bytes > 0
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `from ${assetSource() === 'cdn' ? 'CDN' : 'disk'}`);

/** Short random hex, used for the session id in the header. */
export const sessionId = () =>
  Array.from({ length: 3 }, () =>
    Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')).join('-').toUpperCase();

export function createBootLog(listEl) {
  const write = (status, text, detail = '') => {
    const li = document.createElement('li');
    li.className = `log-line log-${status}`;
    li.innerHTML =
      `<span class="log-status">${status}</span>` +
      `<span class="log-text"></span>` +
      `<span class="log-detail"></span>`;
    li.querySelector('.log-text').textContent = text;
    li.querySelector('.log-detail').textContent = detail;
    listEl.appendChild(li);
    listEl.scrollTop = listEl.scrollHeight;
    return li;
  };

  return {
    write,
    /** Writes a pending line, then resolves it in place once work completes. */
    async step(text, work, { minMs = 180 } = {}) {
      const li = write('..', text);
      const started = performance.now();
      let detail = '';
      let ok = true;
      try {
        detail = (await work()) ?? '';
      } catch (err) {
        ok = false;
        detail = err?.message ?? 'failed';
      }
      const remaining = minMs - (performance.now() - started);
      if (remaining > 0) await sleep(remaining);

      li.className = `log-line log-${ok ? 'ok' : 'err'}`;
      li.querySelector('.log-status').textContent = ok ? 'ok' : '!!';
      li.querySelector('.log-detail').textContent = detail;
      listEl.scrollTop = listEl.scrollHeight;
      return ok;
    },
  };
}

/**
 * Runs the pre-camera portion of boot: runtime checks and model loading.
 * The camera itself is deliberately left until after the consent screen.
 *
 * @param {object} log        from createBootLog
 * @param {() => Promise<void>} loadModels
 */
export async function runBootSequence(log, loadModels) {
  log.write('ok', `${APP.NAME} ${APP.SUBTITLE}`, `v${APP.VERSION}`);
  await sleep(140);

  await log.step('Initialising WebAssembly runtime', async () => {
    const simd = hasSimd();
    return `SIMD: ${simd ? 'detected' : 'unavailable'}`;
  });

  await log.step('Resolving inference backend', async () => {
    // Real check -- reports what the machine can actually offer.
    const gpu = 'gpu' in navigator ? 'WebGPU available' : 'WebGL fallback';
    return gpu;
  });

  const poseBytes = await modelSize('pose');
  const handBytes = await modelSize('hand');

  await log.step('Loading pose_landmarker_lite.task', async () => mb(poseBytes), { minMs: 260 });
  await log.step('Loading hand_landmarker.task', async () => mb(handBytes), { minMs: 240 });

  await log.step('Compiling inference graphs', async () => {
    await loadModels();
    return '33 + 21x2 landmarks';
  }, { minMs: 320 });

  await log.step('Calibrating depth estimation', async () => {
    await sleep(260);
    return 'monocular, normalised';
  });

  const cores = navigator.hardwareConcurrency ?? 0;
  log.write('ok', 'Runtime ready', cores ? `${cores} threads` : '');
}

/**
 * Post-consent boot lines, once the camera stream actually exists.
 * @param {MediaStream} stream
 */
export async function logCameraDetails(log, stream) {
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings?.() ?? {};

  await log.step('Acquiring capture device', async () => track?.label || 'default device');
  await log.step('Negotiating capture format', async () => {
    const w = settings.width ?? '?';
    const h = settings.height ?? '?';
    const fps = Math.round(settings.frameRate ?? 0) || '?';
    return `${w}x${h} @ ${fps}fps`;
  });
}
