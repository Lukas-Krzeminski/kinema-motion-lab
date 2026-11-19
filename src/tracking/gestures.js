/**
 * Stage phase machine.
 *
 *   PLACE     start rings at the anchor; get hands in and hold
 *   PRACTICE  one self-paced rep -- "hit the dots"
 *   SETTLE    a beat with the dot parked at the start, nothing recorded
 *   FILMING   straight in, no countdown. Dots stay user-led; a draining timer
 *             supplies the urgency and closes the window on time.
 *
 * Dots never advance on a clock. The subject sets the pace, which is what
 * makes the footage look like them doing a dance rather than chasing a
 * metronome. The recording window is fixed regardless, so all three clips come
 * out the same length.
 *
 * Detection operates in RAW (unmirrored) landmark space. The preview mirrors x
 * at draw time only, so "subject's left" stays MediaPipe's left throughout.
 *
 * The failsafes advance the PHASE rather than skipping the stage. Somebody who
 * cannot hit a pose still needs to reach FILMING, because otherwise the stage
 * produces no footage and the final video is short a clip.
 */

import { CHOREO, TAKE_SEC, COPY, DETECT, HAND_SHAPE } from '../config.js';
import { torsoScale, handsShape } from './landmarks.js';
import {
  computeTargets,
  createOccupancyTracker,
  createDotSequence,
  createMetronome,
  palmsInward,
} from './targets.js';

export { P, H, dist, mid, angleAt, torsoScale, ramp, band } from './landmarks.js';

export const PHASE = {
  PLACE: 'place',
  PRACTICE: 'practice',
  SETTLE: 'settle',
  FILMING: 'filming',
  DONE: 'done',
};

export function createStageRunner(stage) {
  const occupancy = createOccupancyTracker();
  const practice = createDotSequence({
    cycles: CHOREO.PRACTICE_REPS, steps: stage.sequence });
  // The filmed take is metronome-driven: the dot moves and the subject
  // follows, rather than the dot waiting to be hit.
  const metronome = createMetronome({ steps: stage.sequence });

  let phase, confidence, heldSec, phaseStartedAt, passed, forced, recorderArmed;

  const reset = () => {
    occupancy.reset();
    practice.reset();
    metronome.reset();
    phase = PHASE.PLACE;
    confidence = 0;
    heldSec = 0;
    phaseStartedAt = null;
    passed = false;
    forced = false;
    recorderArmed = false;
  };
  reset();

  const enter = (next, nowSec) => {
    phase = next;
    phaseStartedAt = nowSec;
    confidence = 0;
    heldSec = 0;
    occupancy.reset();
  };

  return {
    config: stage,
    reset,
    /** Operator override -- advances one phase, same as the autopass path. */
    force() { forced = true; },
    get phase() { return phase; },
    get filmedDuration() { return TAKE_SEC; },

    /**
     * @param {object} input
     * @param {number} input.aspect frameHeight / frameWidth, so target geometry
     *   and hit testing stay isotropic on non-square frames.
     */
    update({ pose, hands, handedness, nowSec, dtSec, aspect = 9 / 16 }) {
      if (phaseStartedAt === null) phaseStartedAt = nowSec;

      // Hand shape and palm direction are scored contributors and overlay
      // indicators. Neither can gate a stage on its own.
      const shape = handsShape(hands, stage.hand.shape, HAND_SHAPE);
      const palms = palmsInward(hands, handedness);

      let targets = [];
      let trail = [];
      let activeDot = null;
      let cycle = 0;
      let urgency = null;
      let settle = null;
      let inPhase = 0;
      let relaxed = false;
      // Accumulates across passes, so an event raised in the phase we are
      // leaving is not lost when the dispatch re-runs.
      const events = { startFilming: false, stopFilming: false };

      /*
       * The dispatch re-runs when a phase changes mid-frame, so what comes back
       * describes the phase we ended up IN, not the one we just left.
       *
       * Without this, the frame a phase flips carries the previous phase's
       * target and label -- a one-frame flicker on the overlay, and a frame
       * where the hold still reports the practice dot.
       */
      for (let guard = 0; ; guard++) {
        inPhase = nowSec - phaseStartedAt;

        // Failsafe, applied per phase so a slow PLACE does not eat the take.
        let threshold = DETECT.MATCH_THRESHOLD;
        relaxed = false;
        if (inPhase > DETECT.RELAX_AFTER_SEC) {
          const t = Math.min(1, (inPhase - DETECT.RELAX_AFTER_SEC) /
            Math.max(0.001, DETECT.AUTOPASS_SEC - DETECT.RELAX_AFTER_SEC));
          threshold = DETECT.MATCH_THRESHOLD +
            (DETECT.RELAX_FLOOR - DETECT.MATCH_THRESHOLD) * t;
          relaxed = true;
        }
        const bail = forced || inPhase >= DETECT.AUTOPASS_SEC;

        targets = [];
        trail = [];
        activeDot = null;
        cycle = 0;
        urgency = null;
        settle = null;

        const startedIn = phase;

        // ---- PLACE ---------------------------------------------------------
        // The explanatory screen between stages (see main.js) is what stops a
        // leftover pose from advancing this before the instructions are read.
        if (phase === PHASE.PLACE) {
          targets = computeTargets(stage, pose, { aspect, position: 'start' });
          const occ = occupancy.update(targets, pose, aspect);
          targets = occ.states;

          let raw = occ.fraction;
          // Weight the hands lightly -- position is what actually matters.
          if (shape !== null) raw = raw * 0.86 + shape * 0.14;
          confidence += (raw - confidence) * DETECT.CONFIDENCE_EMA;

          if (confidence >= threshold) heldSec += dtSec;
          else heldSec = Math.max(0, heldSec - dtSec * 1.6);

          if (heldSec >= DETECT.HOLD_SEC || bail) {
            forced = false;
            practice.reset();
            enter(PHASE.PRACTICE, nowSec);
          }

        // ---- PRACTICE ------------------------------------------------------
        } else if (phase === PHASE.PRACTICE) {
          activeDot = practice.dot;
          targets = computeTargets(stage, pose, { aspect, position: activeDot });
          // Where the hands go AFTER this one, drawn as a trail rather than a
          // second ring -- two competing circles made it ambiguous which one to
          // actually move to.
          trail = computeTargets(stage, pose, { aspect, position: practice.nextDot });

          const occ = occupancy.update(targets, pose, aspect);
          targets = occ.states;
          practice.update(occ.allInside);

          confidence += (practice.progress - confidence) * DETECT.CONFIDENCE_EMA;

          // Straight into the take -- no countdown, no hold. The practice rep is
          // the only warm-up, and stopping to count down kills the momentum they
          // just built.
          if (practice.complete || bail) {
            forced = false;
            enter(PHASE.SETTLE, nowSec);
          }

        // ---- SETTLE --------------------------------------------------------
        // The dot parks where the motion begins so they can get set. Nothing is
        // recorded yet, so this costs the clip nothing.
        } else if (phase === PHASE.SETTLE) {
          const order = stage.sequence;
          activeDot = order[order.length - 1];
          targets = computeTargets(stage, pose, { aspect, position: activeDot });
          trail = computeTargets(stage, pose, { aspect, position: order[0] });
          const occ = occupancy.update(targets, pose, aspect);
          targets = occ.states;

          const left = Math.max(0, CHOREO.SETTLE_SEC - inPhase);
          settle = { remaining: left, progress: Math.min(1, inPhase / CHOREO.SETTLE_SEC) };
          confidence = settle.progress;

          // Arm the recorder LEAD_SEC before the hold ends, while the subject is
          // still holding still. MediaRecorder takes a moment to actually start,
          // so warming it up here means the dot can begin moving the instant the
          // bar fills without the first movement being clipped.
          if (!recorderArmed && (inPhase >= CHOREO.SETTLE_SEC - CHOREO.LEAD_SEC || forced)) {
            recorderArmed = true;
            events.startFilming = true;
          }

          if (inPhase >= CHOREO.SETTLE_SEC || forced) {
            forced = false;
            metronome.reset();
            enter(PHASE.FILMING, nowSec);
          }

        // ---- FILMING -------------------------------------------------------
        } else if (phase === PHASE.FILMING) {
          // The lead already elapsed during the settle, so the dot starts moving
          // on the very first frame of this phase -- exactly when the hold bar
          // finished filling.
          if (!metronome.started) metronome.start(nowSec);

          const m = metronome.update(nowSec);
          const activeDotName = m.dot;
          activeDot = activeDotName;
          const nextDot = m.nextDot;

          targets = computeTargets(stage, pose, { aspect, position: activeDot });
          trail = computeTargets(stage, pose, { aspect, position: nextDot });
          const occ = occupancy.update(targets, pose, aspect);
          targets = occ.states;

          cycle = m.cycle;
          const takeProgress = Math.min(1, inPhase / TAKE_SEC);
          confidence = takeProgress;
          urgency = {
            elapsed: inPhase,
            remaining: Math.max(0, TAKE_SEC - inPhase),
            progress: takeProgress,
            urgent: takeProgress >= CHOREO.URGENCY_FROM,
            expired: inPhase >= TAKE_SEC,
          };

          // The take length is what ends it, not the rep count -- that is what
          // keeps all three clips identical.
          if (inPhase >= TAKE_SEC || forced) {
            forced = false;
            events.stopFilming = true;
            passed = true;
            enter(PHASE.DONE, nowSec);
          }
        }

        // A guard cap, so a configuration with zero-length phases cannot spin.
        if (phase === startedIn || guard >= 3) break;
      }

      const copy = phase === PHASE.PRACTICE ? stage.practice
        : phase === PHASE.SETTLE
          ? { instruction: COPY.SETTLE_INSTRUCTION, hint: COPY.SETTLE_HINT }
          : phase === PHASE.FILMING ? stage.filming
            : stage.place;

      // What a ring says once a hand is inside it. "HOLD" is only right while
      // placing; during the motion it has to name the next move, or people
      // park in the ring and wait.
      const occupiedLabel = phase === PHASE.PRACTICE
        ? (practice.nextDot === 'low' ? 'GO DOWN' : 'GO UP')
        : phase === PHASE.FILMING ? 'FOLLOW'
          : phase === PHASE.SETTLE ? 'HOLD' : 'HOLD';

      return {
        phase,
        confidence,
        holdFraction: phase === PHASE.PLACE
          ? Math.min(1, heldSec / DETECT.HOLD_SEC)
          : confidence,
        targets,
        /** Next position, drawn as a directional trail rather than a ring. */
        trail,
        activeDot,
        cycle,
        cycleTarget: CHOREO.FILMED_CYCLES,
        /** {elapsed, remaining, progress, urgent, expired} while filming. */
        urgency,
        /** {remaining, progress} during the settle beat. */
        settle,
        occupiedLabel,
        passed,
        relaxed,
        events,
        filming: phase === PHASE.FILMING,
        checks: {
          position: targets.length
            ? targets.filter((t) => t.inside).length / targets.length
            : 0,
          palms,
          shape,
        },
        instruction: copy.instruction,
        hint: copy.hint,
        scale: pose?.length ? torsoScale(pose) : 0,
      };
    },
  };
}
