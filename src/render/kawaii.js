/**
 * Kawaii face overlay, driven by the 478-point FaceLandmarker mesh.
 *
 * Every element is anchored to real landmarks and scaled by measured face
 * width, so it tracks the head rather than sitting in a fixed screen spot.
 * Roll is recovered from the eye line so the ears tilt with the head.
 */

import { RENDER } from '../config.js';

const K = RENDER.KAWAII;

// --- Face mesh indices -----------------------------------------------------
const F = {
  FOREHEAD: 10,
  CHIN: 152,
  EDGE_L: 234,
  EDGE_R: 454,
  EYE_OUTER_L: 33,
  EYE_OUTER_R: 263,
  CHEEK_L: 50,
  CHEEK_R: 280,
  IRIS_L: [468, 469, 470, 471, 472],
  IRIS_R: [473, 474, 475, 476, 477],
};

const centroid = (lms, idx) => {
  let x = 0, y = 0, n = 0;
  for (const i of idx) {
    const lm = lms[i];
    if (!lm) continue;
    x += lm.x; y += lm.y; n++;
  }
  return n ? { x: x / n, y: y / n } : null;
};

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} lms  478 normalized face landmarks
 * @param {{ox:number, oy:number, w:number, h:number}} rect
 *   Where the subject is drawn on the canvas; landmarks map into it.
 * @param {number} amplitude 0..1, pulses the blush and sparkles
 */
export function drawKawaii(ctx, lms, rect, amplitude = 0) {
  if (!lms?.length) return;
  const { ox, oy, w, h } = rect;
  const pt = (i) => {
    const lm = lms[i];
    return lm ? { x: ox + lm.x * w, y: oy + lm.y * h } : null;
  };
  const mapped = (c) => (c ? { x: ox + c.x * w, y: oy + c.y * h } : null);

  const edgeL = pt(F.EDGE_L), edgeR = pt(F.EDGE_R);
  const forehead = pt(F.FOREHEAD), chin = pt(F.CHIN);
  if (!edgeL || !edgeR || !forehead) return;

  const faceW = Math.hypot(edgeR.x - edgeL.x, edgeR.y - edgeL.y);
  if (!(faceW > 1)) return;
  const faceH = chin ? Math.hypot(chin.x - forehead.x, chin.y - forehead.y) : faceW * 1.35;

  // Head roll from the eye line -- ears and blush inherit it.
  const eyeL = pt(F.EYE_OUTER_L), eyeR = pt(F.EYE_OUTER_R);
  const roll = eyeL && eyeR ? Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x) : 0;

  ctx.save();
  if (K.CAT_EARS) drawEars(ctx, forehead, faceW, faceH, roll);
  drawBlush(ctx, pt(F.CHEEK_L), pt(F.CHEEK_R), faceW, roll, amplitude);
  drawSparkles(ctx, mapped(centroid(lms, F.IRIS_L)), mapped(centroid(lms, F.IRIS_R)), faceW, amplitude);
  ctx.restore();
}

function drawEars(ctx, forehead, faceW, faceH, roll) {
  const size = faceW * K.EAR_SCALE;
  // Sit the ears just above the hairline rather than on the forehead point.
  const baseY = forehead.y - faceH * 0.06;

  for (const dir of [-1, 1]) {
    ctx.save();
    ctx.translate(forehead.x, baseY);
    ctx.rotate(roll);
    ctx.translate(dir * faceW * 0.3, 0);

    ctx.beginPath();
    ctx.moveTo(-size * 0.5, size * 0.28);
    ctx.lineTo(dir * size * 0.16, -size * 0.82);
    ctx.lineTo(size * 0.5, size * 0.28);
    ctx.closePath();
    ctx.fillStyle = K.EAR_COLOR;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-size * 0.26, size * 0.18);
    ctx.lineTo(dir * size * 0.1, -size * 0.46);
    ctx.lineTo(size * 0.26, size * 0.18);
    ctx.closePath();
    ctx.fillStyle = K.EAR_INNER;
    ctx.fill();

    ctx.restore();
  }
}

function drawBlush(ctx, cheekL, cheekR, faceW, roll, amplitude) {
  const rx = faceW * K.BLUSH_SCALE * 0.5 * (1 + amplitude * 0.12);
  const ry = rx * 0.62;

  for (const c of [cheekL, cheekR]) {
    if (!c) continue;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(roll);

    // Radial gradient so the edge dissolves instead of banding.
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, hexToRgba(K.BLUSH_COLOR, K.BLUSH_ALPHA));
    g.addColorStop(0.62, hexToRgba(K.BLUSH_COLOR, K.BLUSH_ALPHA * 0.55));
    g.addColorStop(1, hexToRgba(K.BLUSH_COLOR, 0));

    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawSparkles(ctx, irisL, irisR, faceW, amplitude) {
  const base = faceW * 0.05 * (1 + amplitude * 0.3);

  for (const iris of [irisL, irisR]) {
    if (!iris) continue;
    // A bright core plus a few offset glints reads as an anime eye highlight.
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(iris.x - base * 0.35, iris.y - base * 0.45, base * 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(iris.x + base * 0.5, iris.y + base * 0.3, base * 0.26, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < K.SPARKLE_COUNT; i++) {
      const ang = (i / K.SPARKLE_COUNT) * Math.PI * 2 + amplitude * 2;
      const r = base * 1.5;
      star(ctx, iris.x + Math.cos(ang) * r, iris.y + Math.sin(ang) * r, base * 0.42, 0.55 + amplitude * 0.45);
    }
    ctx.restore();
  }
}

/** Four-point sparkle with concave sides. */
function star(ctx, cx, cy, r, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.quadraticCurveTo(0, 0, 0, r);
  ctx.quadraticCurveTo(0, 0, -r, 0);
  ctx.quadraticCurveTo(0, 0, 0, -r);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
