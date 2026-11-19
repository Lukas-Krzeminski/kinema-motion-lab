/**
 * MediaPipe lifecycle and the per-frame inference scheduler.
 *
 * Capture and render phases use different models and must never be resident
 * at the same time -- four WASM graphs at once will exhaust memory on a
 * laptop. loadCapture()/closeCapture() and loadRender()/closeRender() are
 * strictly paired by main.js.
 *
 * The runtime and models resolve through mediapipe.js, which uses the local
 * vendor/ and models/ copies when they exist and falls back to the CDN when
 * they do not -- so the same checkout runs offline on a laptop and as a
 * one-megabyte public deploy.
 */

import { loadVision } from './mediapipe.js';

/** Populated by initFileset(), once the bundle location is known. */
let MP = null;
let MODELS = null;

let fileset = null;
let poseLandmarker = null;
let handLandmarker = null;
let faceLandmarker = null;
let segmenter = null;

/** Monotonically increasing timestamps are required by the VIDEO running mode. */
let lastTimestamp = -1;
const nextTimestamp = (ms) => (lastTimestamp = Math.max(lastTimestamp + 1, Math.round(ms)));

/** Rolling inference latency, exposed to the HUD. Genuinely measured. */
let latencyMs = 0;
const LATENCY_EMA = 0.15;

export const getLatencyMs = () => latencyMs;

export async function initFileset() {
  if (!fileset) {
    const r = await loadVision();
    MP = r.vision;
    MODELS = r.models;
    fileset = await MP.FilesetResolver.forVisionTasks(r.wasmPath);
  }
  return fileset;
}

/** Real byte sizes for the boot log -- no invented numbers. */
export async function modelSize(key) {
  try {
    if (!MODELS) await initFileset();
    const res = await fetch(MODELS[key], { method: 'HEAD' });
    return Number(res.headers.get('content-length')) || 0;
  } catch {
    return 0;
  }
}

/** Does this browser have WASM SIMD? Reported in the boot log. */
export function hasSimd() {
  try {
    // Minimal module whose body uses v128.const -- validates only with SIMD.
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
      10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Capture phase models
// ---------------------------------------------------------------------------

export async function loadCapture() {
  await initFileset();
  [poseLandmarker, handLandmarker] = await Promise.all([
    MP.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS.pose, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    }),
    MP.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS.hand, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
  ]);
}

export function closeCapture() {
  poseLandmarker?.close();
  handLandmarker?.close();
  poseLandmarker = handLandmarker = null;
}

/**
 * Frame-budget guard. Running pose and hands every frame is fine on a healthy
 * machine; when it is not, alternating them keeps both alive at half rate
 * rather than letting one starve entirely.
 */
let alternate = false;
let frameParity = 0;
let lastHands = [];
let lastHandedness = [];
let lastPose = null;

export function setAlternating(on) {
  alternate = on;
  if (!on) { lastHands = []; lastHandedness = []; }
}
export const isAlternating = () => alternate;

/**
 * @returns {{pose: Array|null, hands: Array, poseResult: object|null}}
 *   Landmarks are normalized 0..1 in unmirrored frame space.
 */
export function detectCapture(video, timeMs) {
  if (!poseLandmarker || !handLandmarker) {
    return { pose: null, hands: [], handedness: [], poseResult: null };
  }

  const started = performance.now();
  frameParity ^= 1;

  let poseResult = null;
  let handResult = null;

  // Pose carries the stage predicates, so it keeps priority when alternating.
  if (!alternate || frameParity === 0) {
    poseResult = poseLandmarker.detectForVideo(video, nextTimestamp(timeMs));
    lastPose = poseResult?.landmarks?.[0] ?? null;
  }
  if (!alternate || frameParity === 1) {
    handResult = handLandmarker.detectForVideo(video, nextTimestamp(timeMs));
    lastHands = handResult?.landmarks ?? [];
    // 'Left'/'Right' per detected hand -- the palm-facing check needs it.
    lastHandedness = (handResult?.handedness ?? []).map((h) => h?.[0]?.categoryName ?? '');
  }

  const elapsed = performance.now() - started;
  latencyMs += (elapsed - latencyMs) * LATENCY_EMA;

  return { pose: lastPose, hands: lastHands, handedness: lastHandedness, poseResult };
}


export function resetCaptureState() {
  lastPose = null;
  lastHands = [];
  lastHandedness = [];
  frameParity = 0;
}

// ---------------------------------------------------------------------------
// Render phase models
// ---------------------------------------------------------------------------

export async function loadRender() {
  await initFileset();
  [faceLandmarker, segmenter] = await Promise.all([
    MP.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS.face, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      // Iris landmarks (468-477) anchor the sparkle-eye overlay.
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }),
    MP.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS.segmenter, delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    }),
  ]);
}

export function closeRender() {
  faceLandmarker?.close();
  segmenter?.close();
  faceLandmarker = segmenter = null;
}

/** @returns {Array|null} 478 face landmarks, or null when no face is found. */
export function detectFace(source, timeMs) {
  if (!faceLandmarker) return null;
  const res = faceLandmarker.detectForVideo(source, nextTimestamp(timeMs));
  return res?.faceLandmarks?.[0] ?? null;
}

/**
 * Runs the selfie segmenter and hands the category mask to `callback`
 * synchronously. The mask is owned by MediaPipe and freed as soon as the
 * callback returns, so it must be consumed, not retained.
 */
export function segment(source, timeMs, callback) {
  if (!segmenter) return;
  segmenter.segmentForVideo(source, nextTimestamp(timeMs), (result) => {
    try {
      callback(result.categoryMask);
    } finally {
      result.close?.();
    }
  });
}

/** Timestamps are shared across models; reset when switching video sources. */
export function resetTimestamps() {
  lastTimestamp = -1;
}
