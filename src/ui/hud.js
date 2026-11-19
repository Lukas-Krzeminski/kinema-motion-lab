/**
 * Capture-screen overlays.
 *
 * The sidebar is gone -- the camera runs full-bleed with three floating cards:
 * hand signal on the left, expression on the right, motion at the bottom
 * centre. A small dim telemetry strip sits top-left behind LAYOUT.SHOW_TELEMETRY.
 *
 * Telemetry values are measured, not invented: frame rate from the RAF clock,
 * inference latency from performance.now() around the detect call, landmark
 * counts straight off the model output, recorder state straight off the
 * MediaRecorder.
 */

import { LAYOUT } from '../config.js';
import { getLatencyMs, isAlternating } from '../tracking/vision.js';
import { PHASE } from '../tracking/gestures.js';

/** Alternating gets switched on below this and off again above the upper mark. */
const FPS_DROP = 20;
const FPS_RECOVER = 26;

export function createHud(root) {
  const fields = {};
  for (const el of root.querySelectorAll('[data-field]')) {
    fields[el.dataset.field] = el;
  }

  const handCard = root.querySelector('[data-hand-card]');
  const handLabel = root.querySelector('[data-hand-label]');
  const handDetail = root.querySelector('[data-hand-detail]');
  const palmRow = root.querySelector('[data-palm-row]');

  const faceCard = root.querySelector('[data-face-card]');
  const faceLabel = root.querySelector('[data-face-label]');

  const motionCard = root.querySelector('[data-motion-card]');
  const stageLabel = root.querySelector('[data-stage-label]');
  const instruction = root.querySelector('[data-stage-instruction]');
  const hint = root.querySelector('[data-stage-hint]');
  const pips = root.querySelector('[data-cycle-pips]');
  const phaseTag = root.querySelector('[data-phase-tag]');
  const urgencyBar = root.querySelector('[data-urgency-bar]');
  const urgencyWrap = root.querySelector('[data-urgency]');

  const telemetry = root.querySelector('[data-telemetry]');
  if (telemetry) telemetry.hidden = !LAYOUT.SHOW_TELEMETRY;

  const set = (key, value, state) => {
    const el = fields[key];
    if (!el) return;
    if (el.textContent !== String(value)) el.textContent = value;
    if (state) el.dataset.state = state;
  };
  const setText = (el, value) => {
    if (el && value !== undefined && el.textContent !== value) el.textContent = value;
  };

  // Frame times over a short window -- a single delta is far too jumpy to show.
  const frameTimes = [];
  let fps = 0;
  let pipCount = -1;

  return {
    /** @returns {number} smoothed fps, so callers can react to load */
    tick(dtSec) {
      if (dtSec > 0) {
        frameTimes.push(dtSec);
        if (frameTimes.length > 30) frameTimes.shift();
        const mean = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
        fps = mean > 0 ? 1 / mean : 0;
      }
      return fps;
    },

    updateTelemetry({ pose, hands, resolution, recorder }) {
      if (!LAYOUT.SHOW_TELEMETRY) return;
      const latency = getLatencyMs();
      set('fps', fps.toFixed(0), fps < FPS_DROP ? 'warn' : 'ok');
      set('latency', `${latency.toFixed(1)}ms`, latency > 45 ? 'warn' : 'ok');
      set('resolution', resolution ?? '--');
      set('landmarks', `${(pose ? pose.length : 0) + (hands?.length ?? 0) * 21}`,
        pose ? 'ok' : 'warn');
      set('tracking', pose ? 'LOCKED' : 'SEARCHING', pose ? 'ok' : 'warn');
      set('mode', isAlternating() ? 'INTERLEAVED' : 'CONTINUOUS');

      // "Is it actually recording?" answerable at a glance -- an early build
      // silently recorded nothing and there was no way to tell.
      if (recorder) {
        const kb = recorder.liveBytes / 1024;
        set('rec', recorder.isRecording
          ? `REC ${kb < 1024 ? `${kb.toFixed(0)}KB` : `${(kb / 1024).toFixed(1)}MB`}`
          : recorder.state,
        recorder.failure ? 'warn' : recorder.isRecording ? 'ok' : undefined);
      }
    },

    /** Sets the static per-stage copy on the side cards. */
    setStage(stage, index, count) {
      handCard.dataset.icon = stage.hand.icon ?? stage.hand.shape;
      setText(handLabel, stage.hand.label);
      setText(handDetail, stage.hand.detail);

      faceCard.dataset.expression = stage.expression.icon;
      setText(faceLabel, stage.expression.label);

      setText(stageLabel,
        `STAGE ${String(stage.stage).padStart(2, '0')} / ${String(count).padStart(2, '0')}`);
    },

    /**
     * The between-stages beat, shown over the live camera.
     *
     * Detection is off during this (main.js holds app.transitioning), so the
     * runner is not producing frames -- this paints the card directly and lets
     * CSS animate the bar over the whole duration.
     */
    showIntro(stage, seconds) {
      setText(instruction, stage.place.instruction);
      setText(hint, stage.place.hint);
      setText(phaseTag, 'GET READY');
      motionCard.dataset.intro = 'true';
      motionCard.dataset.filming = 'false';
      motionCard.dataset.urgent = 'false';
      if (urgencyWrap) urgencyWrap.hidden = false;
      if (urgencyBar) {
        urgencyBar.style.transition = 'none';
        urgencyBar.style.width = '0%';
        requestAnimationFrame(() => {
          urgencyBar.style.transition = `width ${seconds}s linear`;
          urgencyBar.style.width = '100%';
        });
      }
      [...pips.children].forEach((el) => { el.dataset.state = 'pending'; });
    },

    /** Hand the bar back to per-frame control. */
    endIntro() {
      motionCard.dataset.intro = 'false';
      // The CSS transition has to go, or every per-frame width write lags.
      if (urgencyBar) urgencyBar.style.transition = 'none';
    },

    /** Per-frame overlay state. */
    updateStage(result, cycleTarget) {
      if (!result) return;
      setText(instruction, result.instruction);
      setText(hint, result.hint);

      // Hand shape and palm direction are indicators, never gates.
      const shapeOk = (result.checks.shape ?? 0) > 0.6;
      handCard.dataset.state =
        result.checks.shape === null ? 'idle' : shapeOk ? 'ok' : 'pending';

      const palms = result.checks.palms;
      palmRow.dataset.state =
        palms === null || palms === undefined ? 'idle' : palms > 0.5 ? 'ok' : 'pending';

      const filming = result.phase === PHASE.FILMING;
      const settling = result.phase === PHASE.SETTLE;
      motionCard.dataset.filming = String(filming);
      motionCard.dataset.settle = String(settling);

      // Counting the seconds out loud is what makes it land as "movement is
      // about to start" rather than as a pause.
      setText(phaseTag,
        result.phase === PHASE.PLACE ? 'GET IN POSITION'
          : result.phase === PHASE.PRACTICE ? 'PRACTICE'
            : settling
              ? `MOVING IN ${Math.max(1, Math.ceil(result.settle?.remaining ?? 0))}`
              : filming ? 'RECORDING' : 'DONE');

      // Urgency. Dots are user-led, so this draining bar is the only thing
      // pushing people to finish the segment inside the window -- without it
      // there is nothing telling them to hurry.
      const u = result.urgency;
      if (urgencyWrap) urgencyWrap.hidden = !(filming && u) && !(settling && result.settle);
      if (urgencyBar && settling && result.settle) {
        urgencyBar.style.width = `${(result.settle.progress * 100).toFixed(1)}%`;
        motionCard.dataset.urgent = 'false';
      } else if (urgencyBar && filming && u) {
        urgencyBar.style.width = `${((1 - u.progress) * 100).toFixed(1)}%`;
        motionCard.dataset.urgent = String(u.urgent);
      } else if (motionCard.dataset.urgent !== 'false') {
        motionCard.dataset.urgent = 'false';
      }

      // Rep pips, rebuilt only when the count changes.
      if (pipCount !== cycleTarget) {
        pipCount = cycleTarget;
        pips.replaceChildren(...Array.from({ length: cycleTarget }, () => {
          const s = document.createElement('span');
          s.className = 'pip';
          return s;
        }));
      }
      [...pips.children].forEach((el, i) => {
        el.dataset.state = filming && i < result.cycle ? 'done' : 'pending';
      });
    },

    /** Hysteresis so the mode indicator does not flicker at the threshold. */
    shouldAlternate(currentlyAlternating) {
      if (!currentlyAlternating && fps > 0 && fps < FPS_DROP) return true;
      if (currentlyAlternating && fps > FPS_RECOVER) return false;
      return currentlyAlternating;
    },
  };
}
