/**
 * Skeleton and target-zone overlay rendering.
 *
 * Landmarks and targets arrive in unmirrored frame space; the preview is
 * mirrored for the subject's comfort, so x is flipped here at draw time only.
 * Detection never sees the flip.
 */

import { poseConnections, handConnections } from './mediapipe.js';
import { CAPTURE, DETECT } from '../config.js';
import { P } from './landmarks.js';

/*
 * Connection pairs come from the resolved MediaPipe bundle, which may load
 * from disk or from the CDN. They are fetched through a getter rather than
 * imported, because at module-evaluation time the bundle has not loaded yet --
 * and cached on first use, since they never change.
 */
let POSE_CONNECTIONS = null;
let HAND_CONNECTIONS = null;

const ACCENT = '#5ef2d6';
const HAND_ACCENT = '#ffc857';
const TRACK_OK = '#5ef2d6';
const TRACK_HOT = '#ff5c8a';
const TARGET_EMPTY = '#ff5c8a';
const TARGET_FULL = '#5ef2d6';

/** Landmarks below the hips are noisy at desk distance and add nothing here. */
const UPPER_BODY_MAX = 24;

const project = (lm, w, h, mirror) => ({
  x: (mirror ? 1 - lm.x : lm.x) * w,
  y: lm.y * h,
  v: lm.visibility ?? 1,
});

export function resizeOverlay(canvas, video) {
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} frame
 * @param {Array|null} frame.pose
 * @param {Array}  frame.hands
 * @param {Array}  frame.targets  occupancy states for the ACTIVE ring or dot
 * @param {Array}   frame.trail   next position, drawn as a directional path
 * @param {boolean} frame.urgent  true once the filmed window is running short
 * @param {string}  frame.occupiedLabel  what a ring says once a hand is in it
 */
export function drawSkeleton(ctx, {
  pose, hands, targets = [], trail = [], urgent = false, occupiedLabel = 'HOLD',
  confidence = 0, matched = false, timeSec = 0,
}) {
  const { width: w, height: h } = ctx.canvas;
  const mirror = CAPTURE.MIRROR_PREVIEW;
  ctx.clearRect(0, 0, w, h);

  if (pose?.length) {
    const pts = pose.map((lm) => project(lm, w, h, mirror));
    drawPoseEdges(ctx, pts, matched ? TRACK_HOT : TRACK_OK);
    drawPoseJoints(ctx, pts, matched ? TRACK_HOT : TRACK_OK);
  }

  for (const hand of hands ?? []) {
    drawHand(ctx, hand.map((lm) => project(lm, w, h, mirror)));
  }

  // Trail first, so the single active ring always sits on top as THE goal.
  if (trail.length && targets.length) drawTrail(ctx, targets, trail, w, h, mirror, timeSec);
  if (targets.length) drawTargets(ctx, targets, w, h, mirror, timeSec, urgent, occupiedLabel);
}

// ---------------------------------------------------------------------------
// Target zones and guide dots
// ---------------------------------------------------------------------------

const toScreen = (t, w, h, mirror) => ({
  x: (mirror ? 1 - t.x : t.x) * w,
  y: t.y * h,
});

/**
 * A moving trail from the current ring toward the next position.
 *
 * Showing two full rings at once made it ambiguous which one to actually move
 * to, so only the active ring is a ring -- the next position is implied by a
 * path of travelling dots that fade in toward the destination.
 */
function drawTrail(ctx, active, next, w, h, mirror, timeSec) {
  ctx.save();
  for (const dest of next) {
    const to = toScreen(dest, w, h, mirror);

    // Pair each destination with its nearest current ring, so a split (two
    // hands) or a merge (both hands to one point) both trail correctly.
    let from = null;
    let best = Infinity;
    for (const a of active) {
      const p = toScreen(a, w, h, mirror);
      const d = Math.hypot(p.x - to.x, p.y - to.y);
      if (d < best) { best = d; from = p; }
    }
    if (!from || best < 4) continue;

    const BEADS = 6;
    // Beads drift along the path and recycle, so the trail reads as motion
    // with a direction rather than a static dotted line.
    const phase = (timeSec * 0.9) % 1;
    for (let i = 0; i < BEADS; i++) {
      const t = ((i / BEADS) + phase) % 1;
      // Skip the very start so beads emerge from the ring edge, not its centre.
      const eased = 0.18 + t * 0.82;
      const x = from.x + (to.x - from.x) * eased;
      const y = from.y + (to.y - from.y) * eased;
      // Grow and brighten toward the destination.
      ctx.globalAlpha = 0.18 + t * 0.62;
      ctx.fillStyle = TARGET_EMPTY;
      ctx.beginPath();
      ctx.arc(x, y, 3 + t * 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // A soft landing mark so the end of the trail is unambiguous.
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = TARGET_EMPTY;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.arc(to.x, to.y, dest.r * w * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/**
 * The single active ring: where the hands go RIGHT NOW. Empty is dashed pink,
 * occupied fills teal.
 */
function drawTargets(ctx, states, w, h, mirror, timeSec, urgent, occupiedLabel) {
  for (const t of states) {
    const { x: cx, y: cy } = toScreen(t, w, h, mirror);
    // Radius is normalized against frame width, matching how it was computed.
    const r = t.r * w;
    const color = t.inside ? TARGET_FULL : TARGET_EMPTY;

    ctx.save();

    // Idle rings breathe so they read as "come here", and beat faster once
    // the window is running short -- urgency you can feel without reading.
    const rate = urgent ? 8.5 : 3.2;
    const depth = urgent ? 0.075 : 0.04;
    const pulse = t.inside ? 1 : 1 + Math.sin(timeSec * rate) * depth;
    const rr = r * pulse;

    ctx.globalAlpha = t.inside ? 0.26 : 0.16;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = t.inside ? 1 : 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = t.inside ? 5 : 3.5;
    ctx.setLineDash(t.inside ? [] : [12, 9]);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (t.inside) {
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rr + 12, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // Crosshair centre, so the goal is a point rather than a vague area.
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2;
      const k = r * 0.16;
      ctx.beginPath();
      ctx.moveTo(cx - k, cy); ctx.lineTo(cx + k, cy);
      ctx.moveTo(cx, cy - k); ctx.lineTo(cx, cy + k);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = '600 15px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(t.inside ? occupiedLabel : t.label, cx, cy + rr + 26);
    ctx.textAlign = 'left';

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function drawPoseEdges(ctx, pts, color) {
  ctx.save();
  ctx.lineCap = 'round';
  if (!POSE_CONNECTIONS?.length) POSE_CONNECTIONS = poseConnections();
  for (const [a, b] of POSE_CONNECTIONS) {
    if (a > UPPER_BODY_MAX || b > UPPER_BODY_MAX) continue;
    const p1 = pts[a], p2 = pts[b];
    if (!p1 || !p2) continue;
    if (p1.v < DETECT.MIN_VISIBILITY || p2.v < DETECT.MIN_VISIBILITY) continue;

    // Outer glow pass, then a crisp core line.
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = color;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Joints the stage logic actually reads get a larger marker than the rest. */
const KEY_JOINTS = new Set([
  P.L_SHOULDER, P.R_SHOULDER, P.L_ELBOW, P.R_ELBOW, P.L_WRIST, P.R_WRIST,
]);

function drawPoseJoints(ctx, pts, color) {
  ctx.save();
  pts.forEach((p, i) => {
    if (i > UPPER_BODY_MAX || p.v < DETECT.MIN_VISIBILITY) return;
    const key = KEY_JOINTS.has(i);
    const r = key ? 5.5 : 3;

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#04110f';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();

    if (key) {
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  ctx.restore();
}

function drawHand(ctx, pts) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = HAND_ACCENT;

  if (!HAND_CONNECTIONS?.length) HAND_CONNECTIONS = handConnections();
  for (const [alpha, width] of [[0.22, 6], [0.95, 1.8]]) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    for (const [a, b] of HAND_CONNECTIONS) {
      const p1 = pts[a], p2 = pts[b];
      if (!p1 || !p2) continue;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  ctx.fillStyle = HAND_ACCENT;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

