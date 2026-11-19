/**
 * Application state machine.
 *
 * BOOT -> CONSENT -> CAPTURE (x3 stages) -> COMPLETE -> BUILD -> REVEAL
 *
 * Only one screen owns the RAF loop at a time. The capture and render model
 * sets are never resident simultaneously -- the swap happens during the build
 * phase, which is also why the reveal is instant rather than stalling on a
 * model load at the exact moment it needs to land.
 */

import {
  APP, CAPTURE, CHOREO, COPY, COMPLETE_HOLD_MS, DETECT, KEYS, STAGES,
} from './config.js';
import * as vision from './tracking/vision.js';
import { drawSkeleton, resizeOverlay } from './tracking/skeleton.js';
import { createStageRunner } from './tracking/gestures.js';
import { createClipRecorder } from './capture/recorder.js';
import { createScreens } from './ui/screens.js';
import { createBootLog, runBootSequence, logCameraDetails, sessionId } from './ui/boot.js';
import { createHud } from './ui/hud.js';
import { createBuildScreen } from './ui/build.js';
import { createAudioEngine, unlockAudio } from './render/audio.js';
import { createRenderEngine } from './render/engine.js';
import { createExporter, downloadBlob } from './render/export.js';

const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = {
  screens: null,
  hud: null,
  build: null,
  stream: null,
  recorder: null,
  runners: [],
  stageIndex: 0,
  transitioning: false,
  rafId: 0,
  lastFrameMs: 0,
  audio: null,
  renderEngine: null,
  exporter: null,
  exportUrl: null,
};

/**
 * Drives topbar visibility and full-bleed layout from CSS.
 *
 * Uses `data-view` rather than `data-screen`: the sections are identified by
 * `data-screen`, so stamping the same attribute on <body> made
 * querySelector('[data-screen="capture"]') match the BODY instead of the
 * section -- a genuinely confusing collision.
 */
async function showScreen(name) {
  document.body.dataset.view = name;
  await app.screens.show(name);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  $('[data-app-name]').textContent = APP.NAME;
  $('[data-app-subtitle]').textContent = APP.SUBTITLE;
  $('[data-app-version]').textContent = `v${APP.VERSION}`;
  $('[data-app-build]').textContent = APP.BUILD;
  $('[data-session-id]').textContent = sessionId();

  $('[data-consent-title]').textContent = COPY.CONSENT_TITLE;
  $('[data-consent-body]').textContent = COPY.CONSENT_BODY;
  $('[data-consent-note]').textContent = COPY.CONSENT_NOTE;
  $('[data-consent-action]').textContent = COPY.CONSENT_ACTION;
  $('[data-complete-title]').textContent = COPY.COMPLETE_TITLE;

  app.screens = createScreens(document.body);
  app.hud = createHud($('[data-hud]'));

  await showScreen('boot');

  const log = createBootLog($('[data-boot-log]'));
  await runBootSequence(log, () => vision.loadCapture());

  await sleep(320);
  await showScreen('consent');
  $('[data-consent-action]').addEventListener('click', onConsent, { once: true });
}

// ---------------------------------------------------------------------------
// Camera + capture
// ---------------------------------------------------------------------------

async function onConsent() {
  const btn = $('[data-consent-action]');
  const errEl = $('[data-consent-error]');
  btn.disabled = true;
  btn.textContent = 'Requesting device...';
  errEl.hidden = true;

  // Unlock audio HERE, on a real user gesture. The completion screen
  // auto-advances into the build with no click of its own, so without this the
  // AudioContext can refuse to resume and the music silently never starts --
  // which would take the entire reveal with it.
  unlockAudio().catch(() => { /* play() retries */ });

  try {
    app.stream = await navigator.mediaDevices.getUserMedia({
      video: CAPTURE.VIDEO,
      audio: false,
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = COPY.CONSENT_ACTION;
    errEl.hidden = false;
    errEl.textContent =
      err?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow access in the browser address bar, then try again.'
        : `Could not open a capture device: ${err?.message ?? err}`;
    btn.addEventListener('click', onConsent, { once: true });
    return;
  }

  const video = $('[data-cam]');
  video.srcObject = app.stream;
  await video.play();

  await showScreen('boot');
  const log = createBootLog($('[data-boot-log]'));
  await logCameraDetails(log, app.stream);
  await sleep(420);

  app.recorder = createClipRecorder(app.stream);
  app.runners = STAGES.map(createStageRunner);
  app.stageIndex = 0;

  await showScreen('capture');

  // Order matters: the tracking loop starts first so a failure setting up a
  // stage degrades to "tracking works" instead of freezing everything.
  startCaptureLoop();
  await enterStage(0);
}

/**
 * Open a stage with a held beat over the live camera.
 *
 * `app.transitioning` stays true throughout, so the runner is never updated
 * and nothing can be detected. Without this pause, whatever pose the subject is
 * still holding from the previous stage satisfies the next stage's start ring
 * immediately and the stage advances before anyone has read what it asks for.
 *
 * It runs over the camera rather than on its own screen so people can already
 * be getting into position while they read.
 */
async function enterStage(index) {
  const stage = STAGES[index];
  app.runners[index].reset();
  app.hud.setStage(stage, index, STAGES.length);

  app.transitioning = true;
  await showScreen('capture');
  app.hud.showIntro(stage, CHOREO.STAGE_INTRO_SEC);
  await sleep(CHOREO.STAGE_INTRO_SEC * 1000);
  app.hud.endIntro();
  app.transitioning = false;
}

/** A frame-loop fault must never again fail silently the way an early one did. */
function showFault(message) {
  const el = $('[data-fault]');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function startCaptureLoop() {
  app.lastFrameMs = 0;
  vision.resetCaptureState();
  vision.resetTimestamps();
  app.rafId = requestAnimationFrame(captureFrame);
}

function stopCaptureLoop() {
  cancelAnimationFrame(app.rafId);
  app.rafId = 0;
}

/** Set once so a per-frame exception logs a single line, not thousands. */
let frameFaultLogged = false;

function captureFrame(nowMs) {
  app.rafId = requestAnimationFrame(captureFrame);

  const video = $('[data-cam]');
  const overlay = $('[data-overlay]');
  if (video.readyState < 2) return;

  const dtSec = app.lastFrameMs ? Math.min(0.1, (nowMs - app.lastFrameMs) / 1000) : 0;
  app.lastFrameMs = nowMs;

  try {
    app.hud.tick(dtSec);
    vision.setAlternating(app.hud.shouldAlternate(vision.isAlternating()));

    resizeOverlay(overlay, video);
    const ctx = overlay.getContext('2d');

    const { pose, hands, handedness } = vision.detectCapture(video, nowMs);

    // Normalized x spans the width and y the height, so target geometry and
    // hit testing need the frame's aspect to stay isotropic.
    const aspect = (video.videoHeight || 9) / (video.videoWidth || 16);

    let result = null;
    if (!app.transitioning) {
      result = app.runners[app.stageIndex].update({
        pose, hands, handedness, nowSec: nowMs / 1000, dtSec, aspect,
      });
    }

    drawSkeleton(ctx, {
      pose,
      hands,
      targets: result?.targets ?? [],
      trail: result?.trail ?? [],
      urgent: result?.urgency?.urgent ?? false,
      occupiedLabel: result?.occupiedLabel ?? 'HOLD',
      confidence: result?.confidence ?? 0,
      matched: (result?.confidence ?? 0) >= DETECT.MATCH_THRESHOLD,
      timeSec: nowMs / 1000,
    });

    app.hud.updateTelemetry({
      pose, hands,
      resolution: `${video.videoWidth}x${video.videoHeight}`,
      recorder: app.recorder,
    });

    if (result) {
      app.hud.updateStage(result, result.cycleTarget);

      // Recording is bracketed exactly around the filmed take, so each clip IS
      // the take rather than the whole stage -- which is what makes the three
      // clips equal length with no time-stretching in post.
      if (result.events.startFilming && !app.recorder.start()) {
        showFault(`Recording unavailable: ${app.recorder.failure ?? 'unknown'}. `
          + 'Tracking still works, but this run will not produce a video.');
      }

      if (result.events.stopFilming && !app.transitioning) {
        app.transitioning = true;
        advanceStage();
      }
    }
  } catch (err) {
    if (!frameFaultLogged) {
      frameFaultLogged = true;
      console.error('capture frame failed', err);
      showFault(`Tracking fault: ${err?.message ?? err}`);
    }
  }
}

async function advanceStage() {
  const index = app.stageIndex;
  await app.recorder.stop({ stage: STAGES[index].stage });

  if (index + 1 < STAGES.length) {
    app.stageIndex = index + 1;
    // enterStage owns app.transitioning -- it stays true across the
    // explanatory screen and clears once the camera is back.
    await enterStage(app.stageIndex);
    return;
  }

  stopCaptureLoop();
  await showComplete();
}

// ---------------------------------------------------------------------------
// Complete -> build, with no click between them
// ---------------------------------------------------------------------------

async function showComplete() {
  await showScreen('complete');

  // Swap the model sets HERE, while a static screen is up and no animation is
  // running. Doing it during the build made the progress bar stutter: loading
  // two MediaPipe models blocks the main thread for a hundred milliseconds at
  // a time, and rAF simply does not fire while that happens.
  const preload = prepareReveal().catch((err) => {
    console.error('reveal preload failed', err);
  });

  await Promise.race([preload, sleep(COMPLETE_HOLD_MS * 4)]);
  await sleep(COMPLETE_HOLD_MS);
  await onBuild();
}

async function onBuild() {
  await showScreen('build');

  // The context was unlocked back at the camera-permission click.
  app.audio = await createAudioEngine();

  app.build = createBuildScreen({ root: app.screens.el('build'), onComplete: onReveal });

  // Nothing heavy may run from here on -- the bar is animating and any
  // main-thread block shows up as a visible stutter.
  await app.build.run(app.audio);
}

async function prepareReveal() {
  if (app.renderEngine) return;
  vision.closeCapture();
  await vision.loadRender();

  app.renderEngine = createRenderEngine({
    canvas: $('[data-composite]'),
    clips: app.recorder.clips,
    audio: app.audio,
  });
  // Start warm while the reveal screen is still hidden, so the first visible
  // frame already has the subject composited rather than showing black.
  app.renderEngine.start();
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

async function onReveal() {
  app.build?.stop();
  document.body.dataset.revealed = 'true';

  // The build is only a couple of seconds, so the preload may still be in
  // flight. Wait for it rather than showing an empty canvas on the drop.
  let waited = 0;
  while (!app.renderEngine && waited < 6000) {
    await sleep(50);
    waited += 50;
  }
  if (!app.renderEngine) await prepareReveal();

  // The composited video loops forever, so the music should too -- otherwise
  // filming a few passes means the track runs out halfway through.
  app.audio?.enableLoop?.();

  // Rewind so the video opens on the first frame of stage 1 rather than
  // wherever the warm-up run had got to.
  app.renderEngine.restart();
  await showScreen('reveal');

  app.exporter = createExporter($('[data-composite]'), app.audio?.stream?.() ?? null);
  $('[data-export-action]').addEventListener('click', onExport);
  $('[data-restart-action]').addEventListener('click', () => window.location.reload());
  $('[data-clear-action]').addEventListener('click', onClearSession);
}

async function onExport() {
  const btn = $('[data-export-action]');
  const status = $('[data-export-status]');

  if (app.exporter.isRecording) {
    btn.disabled = true;
    status.textContent = 'finalising...';
    const out = await app.exporter.stop();
    if (out) {
      if (app.exportUrl) URL.revokeObjectURL(app.exportUrl);
      app.exportUrl = out.url;
      downloadBlob(out.url, `kinema-reconstruction-${Date.now()}.webm`);
      status.textContent = `saved ${(out.blob.size / 1024 / 1024).toFixed(1)} MB`;
    } else {
      status.textContent = 'nothing recorded';
    }
    btn.disabled = false;
    btn.textContent = 'Record clip';
    return;
  }

  app.exporter.start();
  btn.textContent = 'Stop and save';
  status.textContent = 'recording...';
}

/** Honours the promise made on the consent screen. */
function onClearSession() {
  app.renderEngine?.stop();
  app.recorder?.dispose();
  if (app.exportUrl) {
    URL.revokeObjectURL(app.exportUrl);
    app.exportUrl = null;
  }
  for (const track of app.stream?.getTracks() ?? []) track.stop();
  $('[data-export-status]').textContent = 'session data cleared';
}

// ---------------------------------------------------------------------------
// Operator override
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.key !== KEYS.FORCE_ADVANCE) return;
  if (document.body.dataset.view !== 'capture' || app.transitioning) return;
  // Advances one PHASE, so a struggling subject still reaches a filmed take
  // and the stage still produces a clip.
  app.runners[app.stageIndex]?.force();
});

window.addEventListener('beforeunload', () => {
  for (const track of app.stream?.getTracks() ?? []) track.stop();
});

init().catch((err) => {
  console.error(err);
  const log = $('[data-boot-log]');
  if (log) {
    const li = document.createElement('li');
    li.className = 'log-line log-err';
    li.innerHTML = '<span class="log-status">!!</span><span class="log-text"></span>';
    li.querySelector('.log-text').textContent =
      `Startup failed: ${err?.message ?? err}. Run "node scripts/fetch-deps.mjs" if models are missing.`;
    log.appendChild(li);
  }
});
