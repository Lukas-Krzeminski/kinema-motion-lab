/**
 * Landmark indices and pure geometry helpers.
 *
 * Extracted so targets.js and gestures.js can both use them without importing
 * each other -- gestures.js drives the phases, targets.js supplies the zones
 * and trackers, and a direct dependency in both directions would be circular.
 *
 * All coordinates are normalized 0..1 in unmirrored frame space.
 */

// --- Pose landmark indices (MediaPipe Pose, 33 points) ---------------------
export const P = {
  NOSE: 0,
  L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_PINKY: 17, R_PINKY: 18,
  L_INDEX: 19, R_INDEX: 20,
  L_THUMB: 21, R_THUMB: 22,
  L_HIP: 23, R_HIP: 24,
};

// --- Hand landmark indices (MediaPipe Hands, 21 points) --------------------
export const H = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_TIP: 20,
};

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Angle at vertex b formed by a-b-c, in degrees. */
export function angleAt(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag === 0) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot / mag))) * 180 / Math.PI;
}

/**
 * Characteristic body size used to normalize every distance and offset, so
 * targets and thresholds behave the same whether the subject is close to or
 * far from the camera. Shoulder width, with a shoulder-to-hip fallback for
 * when the shoulders are nearly edge-on.
 */
export function torsoScale(pose) {
  const ls = pose[P.L_SHOULDER], rs = pose[P.R_SHOULDER];
  const shoulder = dist(ls, rs);
  if (shoulder > 0.04) return shoulder;
  const midS = mid(ls, rs);
  const midH = mid(pose[P.L_HIP], pose[P.R_HIP]);
  return Math.max(dist(midS, midH) * 0.6, 0.04);
}

/** 0 below `fail`, 1 above `pass`, linear in between. Handles either order. */
export function ramp(value, fail, pass) {
  if (pass === fail) return value >= pass ? 1 : 0;
  return Math.min(1, Math.max(0, (value - fail) / (pass - fail)));
}

/** 1 when value equals target, falling to 0 at +/- tolerance. */
export function band(value, target, tolerance) {
  if (tolerance <= 0) return value === target ? 1 : 0;
  return Math.min(1, Math.max(0, 1 - Math.abs(value - target) / tolerance));
}

// ---------------------------------------------------------------------------
// Hand shape
// ---------------------------------------------------------------------------

const FINGER_TIPS = [H.INDEX_TIP, H.MIDDLE_TIP, H.RING_TIP, H.PINKY_TIP];

/**
 * Mean fingertip distance from the wrist divided by palm length. Around 1.0
 * for a closed fist, comfortably above 1.4 for a spread hand. Normalizing by
 * palm length keeps it scale-invariant.
 */
export function handOpenness(hand) {
  if (!hand?.length) return 0;
  const wrist = hand[H.WRIST];
  const palm = dist(wrist, hand[H.MIDDLE_MCP]);
  if (palm <= 0) return 0;
  const mean = FINGER_TIPS.reduce((sum, t) => sum + dist(wrist, hand[t]), 0) / FINGER_TIPS.length;
  return mean / palm;
}

/**
 * How well a hand matches the shape a stage asks for.
 *
 * @param {Array} hand 21 landmarks
 * @param {'fist'|'open'} want
 * @param {{FIST_MAX:number, OPEN_MIN:number}} cfg
 * @returns {number} 0..1
 */
export function handShapeScore(hand, want, cfg) {
  if (!hand?.length) return 0;
  const openness = handOpenness(hand);
  return want === 'fist'
    // Below FIST_MAX is a clean fist; it falls off above that.
    ? ramp(openness, cfg.FIST_MAX + 0.28, cfg.FIST_MAX)
    : ramp(openness, cfg.OPEN_MIN - 0.35, cfg.OPEN_MIN);
}

/** Mean shape score across whichever hands are visible. */
export function handsShape(hands, want, cfg) {
  if (!hands?.length) return null;
  return hands.reduce((sum, h) => sum + handShapeScore(h, want, cfg), 0) / hands.length;
}

// ---------------------------------------------------------------------------
// Hand position
// ---------------------------------------------------------------------------

/** Knuckle landmarks that go with each wrist. */
const HAND_CHAIN = {
  [P.L_WRIST]: { index: P.L_INDEX, pinky: P.L_PINKY },
  [P.R_WRIST]: { index: P.R_INDEX, pinky: P.R_PINKY },
};

/**
 * Where the HAND actually is, rather than where the wrist joint is.
 *
 * This matters more than it sounds. The wrist landmark sits at the joint, but
 * a fist pressed to the cheek puts the visible hand a good way above it -- so
 * testing the wrist against a ring centred on the cheek misses by a constant
 * offset, and no amount of widening the ring fixes the bias.
 *
 * Blending the wrist toward the midpoint of the index and pinky knuckles puts
 * the test point in the middle of the hand, which is what people are actually
 * aiming with.
 *
 * @param {Array} pose
 * @param {number} wristIdx P.L_WRIST or P.R_WRIST
 * @param {number} bias 0 = the wrist joint, 1 = the knuckle line
 */
export function handPoint(pose, wristIdx, bias = 0.65) {
  const wrist = pose?.[wristIdx];
  if (!wrist) return null;

  const chain = HAND_CHAIN[wristIdx];
  const index = chain && pose[chain.index];
  const pinky = chain && pose[chain.pinky];

  // Knuckles drop out of tracking more readily than the wrist does, so fall
  // back rather than returning nothing.
  const usable = (lm) => lm && (lm.visibility === undefined || lm.visibility >= 0.3);
  if (!usable(index) || !usable(pinky)) return { x: wrist.x, y: wrist.y };

  const kx = (index.x + pinky.x) / 2;
  const ky = (index.y + pinky.y) / 2;
  return {
    x: wrist.x + (kx - wrist.x) * bias,
    y: wrist.y + (ky - wrist.y) * bias,
  };
}
