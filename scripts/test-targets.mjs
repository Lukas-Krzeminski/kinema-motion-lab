/**
 * Headless checks for the choreography logic.
 *
 * These are pure functions over landmark arrays, so they can be exercised
 * without a camera -- which matters, because the interaction they drive is
 * otherwise only testable by standing in front of a webcam and guessing.
 *
 *   node scripts/test-targets.mjs
 */

import assert from 'node:assert/strict';
import { STAGES, CHOREO, HAND_SHAPE, FILMED_SEC, CLIP_SEC, TARGETS } from '../src/config.js';
import { P, H, handOpenness, handShapeScore, handPoint } from '../src/tracking/landmarks.js';
import { createStageRunner, PHASE } from '../src/tracking/gestures.js';
import {
  computeTargets,
  createOccupancyTracker,
  createDotSequence,
  createMetronome,
  palmInwardScore,
} from '../src/tracking/targets.js';

const ASPECT = 9 / 16;
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

const stageBy = (id) => STAGES.find((s) => s.id === id);

/**
 * Neutral upright pose, shoulders 0.2 wide, arms down.
 *
 * `lWrist` / `rWrist` place the whole HAND: the wrist and both knuckle
 * landmarks are set to that point, so handPoint() resolves to exactly it
 * whatever the bias is. Leaving the knuckles at a dummy position would make
 * every occupancy test measure from a meaningless blend.
 */
function makePose({ lWrist, rWrist } = {}) {
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  pose[P.NOSE] = { x: 0.50, y: 0.28, visibility: 1 };
  pose[P.L_SHOULDER] = { x: 0.60, y: 0.46, visibility: 1 };
  pose[P.R_SHOULDER] = { x: 0.40, y: 0.46, visibility: 1 };
  pose[P.L_EAR] = { x: 0.545, y: 0.26, visibility: 1 };
  pose[P.R_EAR] = { x: 0.455, y: 0.26, visibility: 1 };
  pose[P.L_HIP] = { x: 0.57, y: 0.90, visibility: 1 };
  pose[P.R_HIP] = { x: 0.43, y: 0.90, visibility: 1 };
  pose[P.L_ELBOW] = { x: 0.64, y: 0.62, visibility: 1 };
  pose[P.R_ELBOW] = { x: 0.36, y: 0.62, visibility: 1 };

  const setHand = (pt, wrist, index, pinky) => {
    for (const i of [wrist, index, pinky]) {
      pose[i] = { x: pt.x, y: pt.y, z: 0, visibility: 1 };
    }
  };
  setHand(lWrist ?? { x: 0.66, y: 0.76 }, P.L_WRIST, P.L_INDEX, P.L_PINKY);
  setHand(rWrist ?? { x: 0.34, y: 0.76 }, P.R_WRIST, P.R_INDEX, P.R_PINKY);
  return pose;
}

console.log('\ntarget geometry');

check('every stage produces targets for its start position and both dots', () => {
  const pose = makePose();
  for (const stage of STAGES) {
    for (const position of ['start', 'high', 'low']) {
      const t = computeTargets(stage, pose, { aspect: ASPECT, position });
      assert.ok(t.length > 0, `stage ${stage.id} position ${position} produced nothing`);
      for (const ring of t) {
        assert.ok(Number.isFinite(ring.x) && Number.isFinite(ring.y),
          `stage ${stage.id} produced a non-finite centre`);
        assert.ok(ring.r > 0);
        assert.ok(Array.isArray(ring.wrists) && ring.wrists.length >= 1);
      }
    }
  }
});

check('separated stages give one ring per hand, outside the ears', () => {
  const pose = makePose();
  const t = computeTargets(stageBy('ears'), pose, { aspect: ASPECT, position: 'start' });
  assert.equal(t.length, 2);
  const left = t.find((x) => x.id === 'left');
  const right = t.find((x) => x.id === 'right');
  // Subject's left is higher x in an unmirrored frame.
  assert.ok(left.x > pose[P.L_EAR].x, 'left ring should push further right');
  assert.ok(right.x < pose[P.R_EAR].x, 'right ring should push further left');
  assert.deepEqual(left.wrists, [P.L_WRIST]);
  assert.deepEqual(right.wrists, [P.R_WRIST]);
});

check('the together stage gives ONE centre ring needing both wrists', () => {
  const pose = makePose();
  const t = computeTargets(stageBy('mouth'), pose, { aspect: ASPECT, position: 'start' });
  assert.equal(t.length, 1, 'hands-together should be a single shared ring');
  assert.equal(t[0].id, 'centre');
  assert.deepEqual([...t[0].wrists].sort(), [P.L_WRIST, P.R_WRIST].sort());
  assert.ok(Math.abs(t[0].x - pose[P.NOSE].x) < 0.02, 'centre ring should sit on the midline');
});

check('the high dot is above the low dot for every stage', () => {
  const pose = makePose();
  for (const stage of STAGES) {
    const [hi] = computeTargets(stage, pose, { aspect: ASPECT, position: 'high' });
    const [lo] = computeTargets(stage, pose, { aspect: ASPECT, position: 'low' });
    assert.ok(hi.y < lo.y, `stage ${stage.id}: high dot is not above the low dot`);
  }
});

check('targets scale with distance from the camera', () => {
  const near = makePose();
  const far = makePose();
  far[P.L_SHOULDER] = { x: 0.55, y: 0.46, visibility: 1 };
  far[P.R_SHOULDER] = { x: 0.45, y: 0.46, visibility: 1 };
  const [tn] = computeTargets(stageBy('ears'), near, { aspect: ASPECT, position: 'start' });
  const [tf] = computeTargets(stageBy('ears'), far, { aspect: ASPECT, position: 'start' });
  assert.ok(tf.r < tn.r, 'a smaller subject should get smaller rings');
});

check('rings stay fully inside the frame for a subject high in shot', () => {
  const high = makePose();
  for (const i of [P.NOSE, P.L_EAR, P.R_EAR, P.L_SHOULDER, P.R_SHOULDER]) {
    high[i] = { ...high[i], y: high[i].y - 0.30 };
  }
  for (const stage of STAGES) {
    for (const position of ['start', 'high', 'low']) {
      for (const t of computeTargets(stage, high, { aspect: ASPECT, position })) {
        const ry = t.r / ASPECT;
        assert.ok(t.x - t.r >= -1e-9 && t.x + t.r <= 1 + 1e-9, `off-frame in x: ${t.x}`);
        assert.ok(t.y - ry >= -1e-9 && t.y + ry <= 1 + 1e-9, `off-frame in y: ${t.y}`);
      }
    }
  }
});

console.log('\noccupancy');

check('a wrist inside the ring registers, arms down does not', () => {
  const stage = stageBy('ears');
  const pose = makePose();
  const occ = createOccupancyTracker();

  let r = occ.update(computeTargets(stage, pose, { aspect: ASPECT, position: 'start' }), pose, ASPECT);
  assert.equal(r.allInside, false, 'arms down should not satisfy head targets');

  const t = computeTargets(stage, pose, { aspect: ASPECT, position: 'start' });
  const hit = makePose({
    lWrist: { x: t[0].x, y: t[0].y, visibility: 1 },
    rWrist: { x: t[1].x, y: t[1].y, visibility: 1 },
  });
  r = occ.update(computeTargets(stage, hit, { aspect: ASPECT, position: 'start' }), hit, ASPECT);
  assert.equal(r.allInside, true, 'wrists on the centres should register');
});

check('a together ring needs BOTH wrists, not just one', () => {
  const stage = stageBy('mouth');
  const base = makePose();
  const [t] = computeTargets(stage, base, { aspect: ASPECT, position: 'start' });
  const occ = createOccupancyTracker();

  // Only the left hand arrives.
  const one = makePose({
    lWrist: { x: t.x, y: t.y, visibility: 1 },
    rWrist: { x: 0.18, y: 0.82, visibility: 1 },
  });
  let r = occ.update(computeTargets(stage, one, { aspect: ASPECT, position: 'start' }), one, ASPECT);
  assert.equal(r.allInside, false, 'one hand should not satisfy a together ring');

  // Both fists meet in the middle.
  const both = makePose({
    lWrist: { x: t.x, y: t.y, visibility: 1 },
    rWrist: { x: t.x, y: t.y, visibility: 1 },
  });
  r = occ.update(computeTargets(stage, both, { aspect: ASPECT, position: 'start' }), both, ASPECT);
  assert.equal(r.allInside, true, 'both fists together should register');
});

console.log('\npractice (self-paced)');

check('practice advances only on a hit, and needs a release between hits', () => {
  const seq = createDotSequence({ cycles: 1, steps: ['low', 'high'] });
  assert.equal(seq.dot, 'low', 'the motion drops away from the start position first');
  assert.equal(seq.nextDot, 'high', 'the trail should point back up');

  for (let i = 0; i < 20; i++) seq.update(true);
  assert.equal(seq.step, 1, 'holding inside should score exactly once');
  assert.equal(seq.dot, 'high', 'the next dot should be the high one');

  seq.update(false);
  seq.update(true);
  assert.equal(seq.step, 2);
  assert.equal(seq.complete, true, 'one cycle is two dots');
});

check('every stage moves DOWN from its start position first', () => {
  // Starting on a dot the subject is already standing in gives them nothing
  // to do, so each stage's sequence has to lead away from `start`.
  const pose = makePose();
  for (const stage of STAGES) {
    const seq = createDotSequence({ cycles: 1, steps: stage.sequence });
    const [first] = computeTargets(stage, pose, { aspect: ASPECT, position: seq.dot });
    const [startRing] = computeTargets(stage, pose, { aspect: ASPECT, position: 'start' });
    assert.ok(first.y > startRing.y,
      `stage ${stage.id}: first dot is not below the start position`);
  }
});

check('the trail points at a different place than the active dot', () => {
  const pose = makePose();
  for (const stage of STAGES) {
    const seq = createDotSequence({ cycles: CHOREO.FILMED_CYCLES, steps: stage.sequence });
    assert.notEqual(seq.dot, seq.nextDot, `stage ${stage.id}: trail points at the active dot`);
    const [a] = computeTargets(stage, pose, { aspect: ASPECT, position: seq.dot });
    const [b] = computeTargets(stage, pose, { aspect: ASPECT, position: seq.nextDot });
    assert.ok(Math.abs(a.y - b.y) > 0.02, `stage ${stage.id}: trail has nowhere to travel`);
  }
});

check('practice never completes on its own without hits', () => {
  const seq = createDotSequence({ cycles: 1, steps: ['low', 'high'] });
  for (let i = 0; i < 100; i++) seq.update(false);
  assert.equal(seq.step, 0);
  assert.equal(seq.complete, false);
});

console.log('\nfilmed take (metronome-driven)');

check('the clip is lead + motion + tail, and playback must use the full length', () => {
  // The bug this guards: playback held each clip for only the motion window,
  // so the lead and tail were cut off every clip.
  assert.ok(Math.abs(FILMED_SEC - CHOREO.FILMED_CYCLES * CHOREO.CYCLE_SEC) < 1e-9);
  assert.ok(Math.abs(CLIP_SEC - (CHOREO.LEAD_SEC + FILMED_SEC + CHOREO.TAIL_SEC)) < 1e-9);
  assert.ok(CLIP_SEC > FILMED_SEC, 'the clip must be longer than the motion it contains');
});

check('the dot MOVES on its own -- the subject follows it, not the reverse', () => {
  // This is what lands all three movements on time and makes the take look
  // robotic. The previous user-led version let somebody move slower than the
  // recording window, so only the first reps made it into the clip.
  const m = createMetronome({ steps: ['low', 'high'] });
  m.start(0);
  const half = CHOREO.CYCLE_SEC / 2;
  assert.equal(m.update(0).dot, 'low');
  assert.equal(m.update(half * 1.01).dot, 'high', 'should have moved with no input at all');
  assert.equal(m.update(half * 2.01).dot, 'low');
  assert.equal(m.update(half * 3.01).dot, 'high');
});

check('the metronome fits exactly FILMED_CYCLES movements into the window', () => {
  const m = createMetronome({ steps: ['low', 'high'] });
  m.start(0);
  let peak = 0;
  for (let t = 0; t <= FILMED_SEC + 0.3; t += 0.01) peak = Math.max(peak, m.update(t).cycle);
  assert.equal(peak, CHOREO.FILMED_CYCLES,
    `expected ${CHOREO.FILMED_CYCLES} cycles in the window, got ${peak}`);
  assert.equal(m.update(FILMED_SEC + 0.01).complete, true);
});

check('practice stays self-paced and never advances on its own', () => {
  const seq = createDotSequence({ cycles: 1, steps: ['low', 'high'] });
  for (let i = 0; i < 200; i++) seq.update(false);
  assert.equal(seq.step, 0, 'practice must wait for the subject');
});


console.log('\nchoreography shape');

check('stage 2 is a U: apart at the cheeks, together under the chin', () => {
  const pose = makePose();
  const stage = stageBy('cheeks');
  const hi = computeTargets(stage, pose, { aspect: ASPECT, position: 'high' });
  const lo = computeTargets(stage, pose, { aspect: ASPECT, position: 'low' });

  assert.equal(hi.length, 2, 'cheeks should be two separate rings');
  assert.equal(lo.length, 1, 'under the chin should be one shared ring');
  assert.deepEqual([...lo[0].wrists].sort(), [P.L_WRIST, P.R_WRIST].sort());
  assert.ok(lo[0].y > hi[0].y, 'the chin ring must sit below the cheeks');
  assert.ok(lo[0].x > Math.min(hi[0].x, hi[1].x) && lo[0].x < Math.max(hi[0].x, hi[1].x),
    'the chin ring should sit between the two cheek rings');
});

check('stage 1 dots sit close to the face', () => {
  const pose = makePose();
  const [left] = computeTargets(stageBy('ears'), pose, { aspect: ASPECT, position: 'start' });
  const s = Math.abs(pose[P.L_SHOULDER].x - pose[P.R_SHOULDER].x);
  const gap = (left.x - pose[P.L_EAR].x) / s;
  assert.ok(gap < 0.7, `ring sits ${gap.toFixed(2)} torso units from the ear -- too far out`);
});

check('stage 3 puts the hands below the mouth so the smile is visible', () => {
  // The ring CENTRE is where the wrists go, so that is what has to clear the
  // mouth. The drawn outline passing near it is irrelevant -- only the hands
  // can actually cover a smile.
  const pose = makePose();
  const stage = stageBy('mouth');
  const nose = pose[P.NOSE];
  const s = Math.abs(pose[P.L_SHOULDER].x - pose[P.R_SHOULDER].x);
  // The mouth sits roughly 0.15 torso units below the nose; the chin ~0.32.
  const mouthY = nose.y + (0.15 * s) / ASPECT;
  for (const position of ['start', 'high', 'low']) {
    const [t] = computeTargets(stage, pose, { aspect: ASPECT, position });
    assert.ok(t.y > mouthY,
      `${position} ring centre ${t.y.toFixed(3)} is not below the mouth ${mouthY.toFixed(3)}`);
  }
});

check('stage 3 rings are adjacent -- close together, but two distinct circles', () => {
  const pose = makePose();
  const stage = stageBy('mouth');
  const [hi] = computeTargets(stage, pose, { aspect: ASPECT, position: 'high' });
  const [lo] = computeTargets(stage, pose, { aspect: ASPECT, position: 'low' });
  const gap = lo.y - hi.y;
  const ry = hi.r / ASPECT;
  assert.ok(gap > ry, 'the second ring must be clearly below the first');
  // Close enough to read as a pair stacked at the chin, not a reach to the waist.
  assert.ok(gap < ry * 3.2,
    `stage 3 rings are ${(gap / ry).toFixed(1)} radii apart -- too far to read as a pair`);
});

check('stage 2 cheek rings sit close to the face, not out beside it', () => {
  // They were anchored outward from the EAR, which put them well wide of the
  // head. Anchoring from the nose brings them onto the cheeks.
  const pose = makePose();
  const [l, r] = computeTargets(stageBy('cheeks'), pose, { aspect: ASPECT, position: 'high' });
  const s = Math.abs(pose[P.L_SHOULDER].x - pose[P.R_SHOULDER].x);
  const headHalf = Math.abs(pose[P.L_EAR].x - pose[P.NOSE].x);

  const outer = Math.max(l.x, r.x) - pose[P.NOSE].x;
  assert.ok(outer < headHalf * 1.5,
    `cheek ring sits ${(outer / headHalf).toFixed(2)} head-widths out -- too wide`);
  // And they must not collide in the middle of the face.
  assert.ok(Math.abs(l.x - r.x) > l.r * 1.6,
    'the two cheek rings overlap each other');
});

check('GO DOWN visibly moves the circle on every stage', () => {
  // The bug this guards: stage 3's two rings overlapped so heavily that the
  // label said GO DOWN while the circle barely appeared to move at all.
  const pose = makePose();
  for (const stage of STAGES) {
    const [hi] = computeTargets(stage, pose, { aspect: ASPECT, position: 'high' });
    const [lo] = computeTargets(stage, pose, { aspect: ASPECT, position: 'low' });
    const gap = lo.y - hi.y;
    const ry = hi.r / ASPECT;
    // At least a full radius of travel, or the move does not read as a move.
    assert.ok(gap > ry,
      `stage ${stage.id}: drop ${gap.toFixed(3)} is under one radius ${ry.toFixed(3)}`);
  }
});


check('PLACE is never instant -- a held pose still has to be sustained', () => {
  // The explanatory screen between stages is what stops a leftover pose from
  // advancing things (see enterStage in main.js). This is the runner-side
  // backstop: even a perfect pose has to be held, it cannot pass on frame one.
  const stage = stageBy('cheeks');
  const runner = createStageRunner(stage);
  const rings = computeTargets(stage, makePose(), { aspect: ASPECT, position: 'start' });
  const perfect = makePose({
    lWrist: { x: rings[0].x, y: rings[0].y, visibility: 1 },
    rWrist: { x: rings[1].x, y: rings[1].y, visibility: 1 },
  });

  let t = 0;
  const step = () => runner.update({
    pose: perfect, hands: [], handedness: [], nowSec: t, dtSec: 1 / 60, aspect: ASPECT });

  let r = step();
  assert.equal(r.phase, PHASE.PLACE, 'a stage opens on PLACE');
  for (let i = 0; i < 6; i++) { t += 1 / 60; r = step(); }
  assert.equal(r.phase, PHASE.PLACE, 'a perfect pose must not pass within a few frames');

  for (; t < 4; t += 1 / 60) r = step();
  assert.notEqual(r.phase, PHASE.PLACE, 'a sustained pose should eventually advance');
});

check('an occupied ring names the next move, not just HOLD', () => {
  const stage = stageBy('ears');
  const runner = createStageRunner(stage);
  const rings = computeTargets(stage, makePose(), { aspect: ASPECT, position: 'start' });
  const held = makePose({
    lWrist: { x: rings[0].x, y: rings[0].y, visibility: 1 },
    rWrist: { x: rings[1].x, y: rings[1].y, visibility: 1 },
  });

  let t = 0, r = null;
  const step = () => runner.update({
    pose: held, hands: [], handedness: [], nowSec: t, dtSec: 1 / 60, aspect: ASPECT });

  for (; t < CHOREO.STAGE_INTRO_SEC + 4; t += 1 / 60) r = step();
  assert.ok(r.phase === PHASE.PRACTICE || r.phase === PHASE.FILMING,
    `expected to be moving by now, got ${r.phase}`);
  assert.ok(/^GO (UP|DOWN)$/.test(r.occupiedLabel),
    `mid-motion label should name a direction, got "${r.occupiedLabel}"`);
});

check('stage 2 has more forgiving zones than the other stages', () => {
  // Fists at the cheeks sit close together and the wrist landmark lands behind
  // the hand, so this stage needs a wider catch than the others.
  const pose = makePose();
  const radius = (id) =>
    computeTargets(stageBy(id), pose, { aspect: ASPECT, position: 'high' })[0].r;
  assert.ok(radius('cheeks') > radius('ears'), 'stage 2 zones should be wider than stage 1');
  assert.ok(radius('cheeks') > radius('mouth'), 'stage 2 zones should be wider than stage 3');
  // But not so wide that a wrist could sit in both cheek rings at once.
  const [l, r] = computeTargets(stageBy('cheeks'), pose, { aspect: ASPECT, position: 'high' });
  assert.ok(Math.abs(l.x - r.x) > l.r, 'cheek rings must not swallow each other');
});

check('a wrist that just misses the old zone now registers', () => {
  // Concrete regression: a fist sitting one old-radius out from the centre.
  const pose = makePose();
  const [ring] = computeTargets(stageBy('cheeks'), pose, { aspect: ASPECT, position: 'high' });
  const oldRadius = ring.r / stageBy('cheeks').radiusScale;

  const near = makePose({
    lWrist: { x: ring.x + oldRadius * 1.15, y: ring.y, visibility: 1 },
    rWrist: { x: 0.2, y: 0.8, visibility: 1 },
  });
  const occ = createOccupancyTracker();
  const { states } = occ.update(
    computeTargets(stageBy('cheeks'), near, { aspect: ASPECT, position: 'high' }), near, ASPECT);
  assert.equal(states.find((s) => s.id === 'left').inside, true,
    'a wrist just outside the old radius should now be caught');
});


check('the hold runs its full length before the dot ever moves', () => {
  // The bug this pins: the take used to visibly begin part way through the
  // hold. Nothing may move until the hold bar has completely filled.
  const stage = stageBy('ears');
  const runner = createStageRunner(stage);
  const rings = computeTargets(stage, makePose(), { aspect: ASPECT, position: 'start' });
  const held = makePose({
    lWrist: { x: rings[0].x, y: rings[0].y, visibility: 1 },
    rWrist: { x: rings[1].x, y: rings[1].y, visibility: 1 },
  });

  let t = 0, r = null;
  let sawSettle = false, armedAt = null, filmingAt = null;
  const dotsDuringSettle = new Set();

  for (; t < 60; t += 1 / 60) {
    r = runner.update({ pose: held, hands: [], handedness: [],
      nowSec: t, dtSec: 1 / 60, aspect: ASPECT });
    if (r.phase === PHASE.SETTLE) {
      sawSettle = true;
      if (r.activeDot) dotsDuringSettle.add(r.activeDot);
      // The hold must never flash the recording styling.
      assert.equal(r.urgency, null, 'the hold must not report take urgency');
    }
    if (r.events.startFilming && armedAt === null) armedAt = t;
    if (r.phase === PHASE.FILMING && filmingAt === null) filmingAt = t;
    if (filmingAt !== null) break;
  }

  assert.ok(sawSettle, 'the runner never passed through a hold');
  assert.equal(dotsDuringSettle.size, 1, 'the dot must stay put for the whole hold');
  assert.ok(armedAt !== null, 'the recorder was never armed');
  assert.ok(filmingAt !== null, 'the take never started');

  // The recorder is armed DURING the hold, a lead ahead of the dot moving, so
  // MediaRecorder is warm by the time there is movement to capture.
  assert.ok(armedAt < filmingAt, 'the recorder should be armed before the take');
  const lead = filmingAt - armedAt;
  assert.ok(Math.abs(lead - CHOREO.LEAD_SEC) < 0.05,
    `lead was ${lead.toFixed(3)}s, expected ${CHOREO.LEAD_SEC}s`);
});

check('the take runs exactly FILMED_CYCLES up-and-downs', () => {
  const stage = stageBy('ears');
  const m = createMetronome({ steps: stage.sequence });
  m.start(0);

  let peakCycle = 0;
  const dotsSeen = [];
  for (let t = 0; t <= FILMED_SEC + 0.5; t += 0.01) {
    const u = m.update(t);
    peakCycle = Math.max(peakCycle, u.cycle);
    if (!dotsSeen.length || dotsSeen[dotsSeen.length - 1] !== u.dot) dotsSeen.push(u.dot);
  }

  assert.equal(peakCycle, CHOREO.FILMED_CYCLES,
    `expected exactly ${CHOREO.FILMED_CYCLES} cycles, saw ${peakCycle}`);
  // One cycle is two steps, so three cycles is six distinct dot changes.
  assert.equal(dotsSeen.length, CHOREO.FILMED_CYCLES * stage.sequence.length,
    `expected ${CHOREO.FILMED_CYCLES * 2} movements, saw ${dotsSeen.length}`);
});



console.log('\nhand point (vs wrist joint)');

check('the test point sits up at the hand, not down at the wrist joint', () => {
  const pose = makePose();
  // Knuckles well above the wrist, as when a fist is raised to the face.
  pose[P.L_WRIST] = { x: 0.60, y: 0.50, visibility: 1 };
  pose[P.L_INDEX] = { x: 0.60, y: 0.36, visibility: 1 };
  pose[P.L_PINKY] = { x: 0.60, y: 0.36, visibility: 1 };

  const hp = handPoint(pose, P.L_WRIST, 0.65);
  assert.ok(hp.y < pose[P.L_WRIST].y, 'the hand point must sit above the wrist');
  assert.ok(hp.y > pose[P.L_INDEX].y, 'but not past the knuckles themselves');
});

check('it falls back to the wrist when the knuckles are not tracked', () => {
  const pose = makePose();
  pose[P.L_WRIST] = { x: 0.6, y: 0.5, visibility: 1 };
  pose[P.L_INDEX] = { x: 0.6, y: 0.3, visibility: 0.05 };
  pose[P.L_PINKY] = { x: 0.6, y: 0.3, visibility: 0.05 };
  const hp = handPoint(pose, P.L_WRIST, 0.65);
  assert.equal(hp.y, 0.5, 'untracked knuckles should not drag the point anywhere');
  assert.equal(handPoint(pose, 999), null);
});

check('a fist at the cheek registers even though its wrist hangs below', () => {
  // The exact failure this fixes: the hand is on target but the wrist joint,
  // several inches lower, falls outside the ring. Widening the ring could
  // never fix this -- the error is a constant offset, not a tolerance.
  const stage = stageBy('cheeks');
  const base = makePose();
  const [ring] = computeTargets(stage, base, { aspect: ASPECT, position: 'high' });

  const pose = makePose();
  pose[P.L_INDEX] = { x: ring.x, y: ring.y, visibility: 1 };
  pose[P.L_PINKY] = { x: ring.x, y: ring.y, visibility: 1 };
  pose[P.L_WRIST] = { x: ring.x, y: ring.y + 0.13, visibility: 1 };

  // The wrist alone is outside the ring...
  const wristMiss = Math.hypot(0, 0.13 * ASPECT) > ring.r;
  assert.ok(wristMiss, 'fixture is wrong: the wrist should be outside the ring');

  // ...but the hand point is inside, so it registers.
  const occ = createOccupancyTracker();
  const { states } = occ.update(
    computeTargets(stage, pose, { aspect: ASPECT, position: 'high' }), pose, ASPECT);
  assert.equal(states.find((s) => s.id === 'left').inside, true,
    'a fist on target should register despite the wrist being low');
});


console.log('\nhand shape');

check('a fist scores as a fist and an open hand as open', () => {
  // Fingertips near the wrist = fist; far = open.
  const mk = (reach) => {
    const hand = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    hand[H.WRIST] = { x: 0.5, y: 0.6, z: 0 };
    hand[H.MIDDLE_MCP] = { x: 0.5, y: 0.55, z: 0 };
    for (const tip of [H.INDEX_TIP, H.MIDDLE_TIP, H.RING_TIP, H.PINKY_TIP]) {
      hand[tip] = { x: 0.5, y: 0.6 - reach, z: 0 };
    }
    return hand;
  };
  const fist = mk(0.05);
  const open = mk(0.14);
  assert.ok(handOpenness(fist) < handOpenness(open), 'openness should order correctly');
  assert.ok(handShapeScore(fist, 'fist', HAND_SHAPE) > 0.7, 'fist should score as a fist');
  assert.ok(handShapeScore(open, 'open', HAND_SHAPE) > 0.7, 'open hand should score as open');
  assert.ok(handShapeScore(fist, 'open', HAND_SHAPE) < 0.3, 'a fist is not an open hand');
});

console.log('\npalm facing');

check('mirrored palms score on opposite sides of 0.5', () => {
  const mk = (flip) => {
    const hand = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    hand[H.WRIST] = { x: 0.50, y: 0.60, z: 0 };
    hand[H.INDEX_MCP] = { x: 0.50 + 0.06 * flip, y: 0.50, z: 0 };
    hand[H.MIDDLE_MCP] = { x: 0.50 + 0.02 * flip, y: 0.49, z: 0 };
    hand[H.PINKY_MCP] = { x: 0.50 - 0.04 * flip, y: 0.52, z: 0 };
    return hand;
  };
  const a = palmInwardScore(mk(1), 'Right');
  const b = palmInwardScore(mk(-1), 'Right');
  assert.ok((a - 0.5) * (b - 0.5) < 0, `expected opposite signs, got ${a} and ${b}`);
});

check('handedness flips the verdict for identical geometry', () => {
  const hand = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  hand[H.WRIST] = { x: 0.50, y: 0.60, z: 0 };
  hand[H.INDEX_MCP] = { x: 0.56, y: 0.50, z: 0 };
  hand[H.MIDDLE_MCP] = { x: 0.52, y: 0.49, z: 0 };
  hand[H.PINKY_MCP] = { x: 0.46, y: 0.52, z: 0 };
  const l = palmInwardScore(hand, 'Left');
  const r = palmInwardScore(hand, 'Right');
  assert.ok((l - 0.5) * (r - 0.5) < 0, 'left and right must disagree');
});

check('degenerate input does not throw or claim confidence', () => {
  const flat = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const score = palmInwardScore(flat, 'Left');
  assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
  assert.equal(palmInwardScore(null, 'Left'), 0);
  assert.equal(handShapeScore(null, 'fist', HAND_SHAPE), 0);
  assert.deepEqual(computeTargets(STAGES[0], [], { aspect: ASPECT, position: 'start' }), []);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);
