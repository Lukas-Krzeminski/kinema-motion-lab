/**
 * Target zones, guide dots, motion timing and palm facing.
 *
 * Instead of asking somebody to strike a pose and scoring it invisibly, rings
 * appear where their hands should go and dots show where to move next. What
 * the app wants is self-evident, and so is what is still missing.
 *
 * All geometry is in TORSO UNITS (multiples of shoulder width) and all
 * coordinates are normalized 0..1 in unmirrored frame space, matching the
 * landmarks. Mirroring happens only at draw time.
 *
 * Aspect handling: normalized x spans the frame WIDTH and y spans the HEIGHT,
 * so on a 16:9 frame the same pixel distance is a larger number in y than in
 * x. Torso units are width-relative (shoulder width is near-horizontal), so
 * vertical offsets are divided by `aspect` and vertical distances multiplied
 * by it. Without that the drawn circle and the hit region would not match.
 */

import { TARGETS, CHOREO, DETECT, PALM_INWARD_SIGN } from '../config.js';
import { P, H, torsoScale, dist, handPoint } from './landmarks.js';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Where a stage's rings sit for one position of the choreography.
 *
 * @param {object} stage from STAGES
 * @param {Array}  pose
 * @param {{aspect?:number, position?:'start'|'high'|'low'}} opts
 * @returns {Array<{id,x,y,r,label,wrists:number[]}>}
 */
export function computeTargets(stage, pose, opts = {}) {
  if (!pose?.length) return [];

  const key = opts.position ?? 'start';
  const pos = stage.positions?.[key];
  if (!pos) return [];

  const s = torsoScale(pose);
  const aspect = opts.aspect || 9 / 16;
  // `radiusScale` lets one stage have more forgiving zones without loosening
  // every other stage's.
  const r = (key === 'start' ? TARGETS.RADIUS : TARGETS.DOT_RADIUS)
    * (stage.radiusScale ?? 1) * s;

  // Convert a width-relative offset into normalized-y units.
  const vy = (d) => (d * s) / aspect;

  const anchor = TARGETS.ANCHORS[stage.anchor];
  if (!anchor) return [];

  const dy = anchor.dy + pos.dy;

  // Keep rings fully inside the frame. A ring somebody cannot see is a stage
  // that has silently become impossible.
  const ry = r / aspect;
  const clamp = (t) => ({
    ...t,
    x: Math.min(1 - r, Math.max(r, t.x)),
    y: Math.min(1 - ry, Math.max(ry, t.y)),
  });

  const nose = pose[P.NOSE];
  const ls = pose[P.L_SHOULDER], rs = pose[P.R_SHOULDER];
  const midX = nose?.x ?? (ls.x + rs.x) / 2;
  const baseY = nose?.y ?? (ls.y + rs.y) / 2;

  // `together` is a property of the POSITION, not the stage, so a stage can
  // split and rejoin -- stage 2 is apart at the cheeks and together under the
  // chin, which is what makes the U shape.
  if (pos.together) {
    return [clamp({
      id: 'centre',
      x: midX,
      y: baseY + vy(dy),
      r,
      label: 'BOTH HANDS',
      wrists: [P.L_WRIST, P.R_WRIST],
    })];
  }

  // Separated rings hang off the ear (pushed outward) or the nose (pushed out
  // from the midline). Subject's left sits at higher x in an unmirrored frame.
  const lEar = pose[P.L_EAR], rEar = pose[P.R_EAR];
  const useNose = anchor.fromNose !== undefined;
  const lx = useNose ? midX + anchor.fromNose * s : lEar.x + anchor.fromEar * s;
  const rx = useNose ? midX - anchor.fromNose * s : rEar.x - anchor.fromEar * s;
  const ly = (useNose ? baseY : lEar.y) + vy(dy);
  const ry2 = (useNose ? baseY : rEar.y) + vy(dy);

  return [
    { id: 'left', x: lx, y: ly, r, label: 'LEFT HAND', wrists: [P.L_WRIST] },
    { id: 'right', x: rx, y: ry2, r, label: 'RIGHT HAND', wrists: [P.R_WRIST] },
  ].map(clamp);
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

/**
 * Tracks which wrists are inside which rings, with hysteresis so a wrist
 * hovering on a boundary does not flicker the whole UI.
 */
export function createOccupancyTracker() {
  /** @type {Map<string, boolean>} */
  const inside = new Map();

  return {
    reset() { inside.clear(); },

    /** @returns {{states:Array, allInside:boolean, fraction:number}} */
    update(targets, pose, aspect = 9 / 16) {
      if (!pose?.length || !targets.length) {
        return { states: [], allInside: false, fraction: 0 };
      }

      const states = targets.map((t) => {
        const was = inside.get(t.id) ?? false;
        // Wider radius to leave than to enter.
        const limit = was ? t.r * TARGETS.HYSTERESIS : t.r;

        // Test where the HAND is, not the wrist joint -- see handPoint().
        const pts = t.wrists
          .map((i) => handPoint(pose, i, DETECT.HAND_POINT_BIAS))
          .filter(Boolean);
        let worst = Infinity;
        let all = false;

        if (t.wrists.length > 1) {
          // Shared ring: test the MIDPOINT of the two wrists and require them
          // to actually be near each other. Demanding each wrist sit inside
          // independently made this flicker constantly, because clasped hands
          // put the wrists right on the rim rather than at the centre.
          if (pts.length === t.wrists.length) {
            const mx = pts.reduce((a, w) => a + w.x, 0) / pts.length;
            const my = pts.reduce((a, w) => a + w.y, 0) / pts.length;
            worst = Math.hypot(mx - t.x, (my - t.y) * aspect);
            const spread = Math.hypot(
              pts[0].x - pts[1].x, (pts[0].y - pts[1].y) * aspect);
            all = worst <= limit && spread <= t.r * TARGETS.TOGETHER_SPREAD;
          }
        } else {
          const w = pts[0];
          // Scale y into width-relative units so the hit region is the circle
          // that is actually drawn, not an ellipse.
          worst = w ? Math.hypot(w.x - t.x, (w.y - t.y) * aspect) : Infinity;
          all = worst <= limit;
        }

        inside.set(t.id, all);
        return {
          ...t,
          inside: all,
          distance: worst,
          proximity: Math.max(0, 1 - worst / (t.r * 2)),
        };
      });

      const n = states.filter((s) => s.inside).length;
      return {
        states,
        allInside: n === states.length,
        // Partial credit so the confidence ring moves as they get closer.
        fraction: states.reduce(
          (sum, s) => sum + (s.inside ? 1 : s.proximity * 0.6), 0) / states.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Motion sequencing
// ---------------------------------------------------------------------------

/** Default order. Stages override it -- all three currently drop first. */
export const STEPS = ['low', 'high'];

/**
 * User-led dot sequence. The dot advances when it is actually HIT, never on a
 * clock -- so the movement is the subject's own rather than them chasing a
 * metronome. Used for both the practice rep and the filmed segment.
 *
 * `steps` is the stage's own order, so a stage can start by moving down from
 * its resting position rather than up.
 */
export function createDotSequence({ cycles = 1, steps = STEPS } = {}) {
  const order = steps?.length ? steps : STEPS;
  const total = cycles * order.length;
  let step = 0;
  let armed = true;

  return {
    get dot() { return order[step % order.length]; },
    /** Where the trail should point next. */
    get nextDot() { return order[(step + 1) % order.length]; },
    get step() { return step; },
    get total() { return total; },
    get cycles() { return Math.floor(step / order.length); },
    get complete() { return step >= total; },
    get progress() { return Math.min(1, step / total); },
    reset() { step = 0; armed = true; },

    /** @param {boolean} reached is every wrist inside the current dot */
    update(reached) {
      if (reached && armed) {
        step++;
        armed = false;
      } else if (!reached) {
        // Must leave the dot before the next one can score.
        armed = true;
      }
      return step;
    },
  };
}

/**
 * The filmed take's moving dot.
 *
 * Unlike the practice sequence this does NOT wait for anybody -- the dot moves
 * on a strict clock and the subject follows it. That is what lands all three
 * movements on time and gives the take its deliberately robotic look, and it
 * is also what guarantees the movement fits inside the recording window.
 */
export function createMetronome({
  cycles = CHOREO.FILMED_CYCLES,
  cycleSec = CHOREO.CYCLE_SEC,
  steps = STEPS,
} = {}) {
  const order = steps?.length ? steps : STEPS;
  const stepSec = cycleSec / order.length;
  const totalSteps = cycles * order.length;
  const durationSec = cycles * cycleSec;
  let startedAt = null;

  const idle = {
    dot: order[0], nextDot: order[1 % order.length], step: 0, cycle: 0,
    elapsed: 0, stepProgress: 0, progress: 0, complete: false,
  };

  return {
    get duration() { return durationSec; },
    get started() { return startedAt !== null; },
    reset() { startedAt = null; },
    start(nowSec) { startedAt = nowSec; },

    update(nowSec) {
      if (startedAt === null) return idle;
      const elapsed = nowSec - startedAt;
      const step = Math.min(Math.floor(elapsed / stepSec), totalSteps - 1);
      return {
        dot: order[step % order.length],
        nextDot: order[(step + 1) % order.length],
        step,
        cycle: Math.min(cycles, Math.floor(step / order.length) + 1),
        elapsed,
        stepProgress: (elapsed % stepSec) / stepSec,
        progress: Math.min(1, elapsed / durationSec),
        complete: elapsed >= durationSec,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Palm facing
// ---------------------------------------------------------------------------

/**
 * Is the palm facing the subject (back of hand toward the camera)?
 *
 * The 2D chirality of wrist -> index_mcp -> pinky_mcp flips with palm
 * direction, and flips again between left and right hands -- so combining the
 * signed area with the handedness label gives facing without relying on
 * MediaPipe's z, which is relative and noisy.
 *
 * @returns {number} 0..1, where >0.5 means the palm faces the subject
 */
export function palmInwardScore(hand, handedness) {
  if (!hand?.length) return 0;
  const wrist = hand[H.WRIST];
  const index = hand[H.INDEX_MCP];
  const pinky = hand[H.PINKY_MCP];
  if (!wrist || !index || !pinky) return 0;

  const v1x = index.x - wrist.x, v1y = index.y - wrist.y;
  const v2x = pinky.x - wrist.x, v2y = pinky.y - wrist.y;
  const cross = v1x * v2y - v1y * v2x;

  // Normalize by palm area so an edge-on hand reports low confidence rather
  // than a confident wrong answer.
  const palm = dist(wrist, hand[H.MIDDLE_MCP]);
  if (palm <= 0) return 0;
  const strength = Math.min(1, Math.abs(cross) / (palm * palm * 0.9));

  const chirality = handedness === 'Left' ? -1 : 1;
  const inward = Math.sign(cross) * chirality * PALM_INWARD_SIGN > 0;

  // Ambiguous (edge-on) hands land near 0.5 rather than at either extreme.
  return inward ? 0.5 + strength * 0.5 : 0.5 - strength * 0.5;
}

/** Mean palm-inward score across detected hands. */
export function palmsInward(hands, handedness) {
  if (!hands?.length) return null;
  const scores = hands.map((h, i) => palmInwardScore(h, handedness?.[i]));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
