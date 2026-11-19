#!/usr/bin/env node
/**
 * One-time dependency fetcher.
 *
 * Pulls the MediaPipe tasks-vision ESM bundle, its WASM runtime, and the four
 * model files into vendor/ and models/. After this runs the app is fully
 * offline -- no CDN, no npm install, no bundler.
 *
 *   node scripts/fetch-deps.mjs          fetch anything missing
 *   node scripts/fetch-deps.mjs --force  re-fetch everything
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

const MP_VERSION = '1.0.1';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_HOST = 'https://storage.googleapis.com/mediapipe-models';

const TARGETS = [
  // --- MediaPipe runtime -------------------------------------------------
  { url: `${CDN}/vision_bundle.mjs`, dest: 'vendor/tasks-vision/vision_bundle.mjs' },
  { url: `${CDN}/wasm/vision_wasm_internal.js`, dest: 'vendor/tasks-vision/wasm/vision_wasm_internal.js' },
  { url: `${CDN}/wasm/vision_wasm_internal.wasm`, dest: 'vendor/tasks-vision/wasm/vision_wasm_internal.wasm' },
  { url: `${CDN}/wasm/vision_wasm_nosimd_internal.js`, dest: 'vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.js' },
  { url: `${CDN}/wasm/vision_wasm_nosimd_internal.wasm`, dest: 'vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm' },

  // --- Models ------------------------------------------------------------
  // Capture phase
  { url: `${MODEL_HOST}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    dest: 'models/pose_landmarker_lite.task' },
  { url: `${MODEL_HOST}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
    dest: 'models/hand_landmarker.task' },
  // Render phase
  { url: `${MODEL_HOST}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    dest: 'models/face_landmarker.task' },
  { url: `${MODEL_HOST}/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite`,
    dest: 'models/selfie_segmenter.tflite' },
];

const mb = (b) => (b / 1024 / 1024).toFixed(1).padStart(6) + ' MB';

async function exists(path) {
  try { return (await stat(path)).size > 0; } catch { return false; }
}

async function fetchOne(target, index, total) {
  const dest = resolve(ROOT, target.dest);
  const label = `[${String(index + 1).padStart(2)}/${total}] ${target.dest}`;

  if (!FORCE && await exists(dest)) {
    const { size } = await stat(dest);
    console.log(`${label}\n         skip (present) ${mb(size)}`);
    return size;
  }

  await mkdir(dirname(dest), { recursive: true });
  process.stdout.write(`${label}\n         downloading...`);

  const res = await fetch(target.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${target.url}`);

  // Write to a temp file first so an interrupted run never leaves a
  // half-written model that later "exists" and gets skipped.
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);

  const { size } = await stat(dest);
  process.stdout.write(`\r         done           ${mb(size)}      \n`);
  return size;
}

console.log('\nKINEMA Motion Lab -- fetching local dependencies\n');

let total = 0;
for (const [i, t] of TARGETS.entries()) {
  try {
    total += await fetchOne(t, i, TARGETS.length);
  } catch (err) {
    await unlink(resolve(ROOT, `${t.dest}.part`)).catch(() => {});
    console.error(`\n  FAILED: ${t.dest}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

console.log(`\n  total on disk: ${mb(total).trim()}`);
console.log(process.exitCode
  ? '\n  Some files failed. Re-run to retry just the missing ones.\n'
  : '\n  Ready. Start the app with:  node serve.mjs\n');
