/**
 * The "built video" compositor.
 *
 * Not an encoded file -- a live full-screen canvas loop. That keeps playback
 * smooth (no encode stall before the reveal) while still being exportable to a
 * real .webm via export.js.
 *
 * Per frame: paint the pink field, spawn hearts BEHIND the subject, segment the
 * subject out of the recorded clip, sweep them horizontally in time with the
 * music, and overlay the kawaii face.
 *
 * Clips are held for exactly CLIP_SEC each, so the three filmed takes play as
 * equal thirds without any time-stretching.
 */

import { RENDER, CLIP_SEC, CLIP_TRIM_SEC } from '../config.js';
import { detectFace, segment, resetTimestamps } from '../tracking/vision.js';
import { createCutter } from './segmentation.js';
import { drawKawaii } from './kawaii.js';
import { createHeartField } from './hearts.js';

const W = RENDER.WIDTH;
const H = RENDER.HEIGHT;
const BG = RENDER.BACKGROUND;
const SWEEP = RENDER.SWEEP;

export function createRenderEngine({ canvas, clips, audio }) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const cutter = createCutter(W, H);
  const hearts = createHeartField(W, H);

  // Hidden element that plays the recorded clips back to back.
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  // Loop within a clip so a blob that came back a few frames short never
  // shows black before its window is up.
  // Looping is handled manually so each pass can resume past the trim point;
  // el.loop can only rewind to zero, which would replay the dead air.
  video.loop = false;
  video.style.display = 'none';
  document.body.appendChild(video);

  let clipIndex = 0;
  let running = false;
  let rafId = 0;
  let lastFrameMs = 0;
  let elapsed = 0;
  let clipElapsed = 0;
  let amplitude = 0;
  let faceLandmarks = null;
  let frameCounter = 0;

  // Explicitly ordered by stage so the video always opens on stage 1 (open
  // hands, palms in) rather than depending on recording order.
  const playable = clips.filter((c) => c?.url).sort((a, b) => a.stage - b.stage);

  const loadClip = (i) => {
    if (!playable.length) return;
    clipIndex = i % playable.length;
    clipElapsed = 0;
    video.src = playable[clipIndex].url;
    seekToStart();
    video.play().catch(() => { /* autoplay guard; retried on next ended */ });
  };

  // MediaRecorder blobs frequently carry no duration metadata, so clips are
  // sequenced on a fixed timer rather than by the 'ended' event. Every filmed
  // clip is CLIP_SEC long by construction (lead + motion + tail), so holding each
  // for exactly that makes the three segments equal thirds regardless of blob
  // length. Using the shorter FILMED_SEC here cut the tail off every clip.
  /**
   * Skip the recorder lead and the moment of reaction after it, so the clip
   * opens on movement rather than on someone standing still.
   *
   * Seeking into a MediaRecorder blob is not always honoured -- the container
   * often lacks cues -- so this is best effort: if the seek does not take, the
   * clip simply plays from the top, which is what it did before.
   */
  const seekToStart = () => {
    try {
      video.currentTime = CLIP_TRIM_SEC;
    } catch {
      /* plays from 0 instead */
    }
  };

  video.addEventListener('loadedmetadata', seekToStart);
  video.addEventListener('ended', () => {
    // Manual loop, back to the trim point rather than to zero.
    seekToStart();
    video.play().catch(() => { /* nothing else to try */ });
  });
  video.addEventListener('error', () => loadClip(clipIndex + 1));

  function drawBackground() {
    // Flat pink. No gradient, no sunburst -- anything moving back here
    // competes with the subject for attention.
    ctx.fillStyle = BG.COLOR;
    ctx.fillRect(0, 0, W, H);
  }

  /** Horizontal sweep plus an audio-reactive bob. */
  function subjectTransform(t) {
    const cycleSec = SWEEP.BEATS_PER_SWEEP / (SWEEP.BPM / 60);
    const phase = (t / cycleSec) * Math.PI * 2;
    const dx = Math.sin(phase) * SWEEP.AMPLITUDE * W;
    const bounce = -Math.abs(Math.sin(phase * 2)) * SWEEP.BOUNCE_PX * (0.4 + amplitude);

    const pw = W * SWEEP.SCALE;
    const ph = H * SWEEP.SCALE;
    return {
      ox: (W - pw) / 2 + dx,
      oy: (H - ph) + bounce,
      w: pw,
      h: ph,
    };
  }

  function drawSubject(rect) {
    const person = cutter.cut(video);

    ctx.save();
    // Mirror so the subject sees themselves the way they did during capture.
    // Person and overlay share this transform, so landmarks stay aligned.
    ctx.translate(W, 0);
    ctx.scale(-1, 1);

    // Soft glow beneath, so the cutout does not look pasted on.
    ctx.save();
    ctx.globalAlpha = 0.33;
    ctx.filter = 'blur(26px)';
    ctx.drawImage(person, rect.ox, rect.oy, rect.w, rect.h);
    ctx.restore();

    ctx.drawImage(person, rect.ox, rect.oy, rect.w, rect.h);
    if (faceLandmarks) drawKawaii(ctx, faceLandmarks, rect, amplitude);
    ctx.restore();
  }

  function frame(nowMs) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    const dt = lastFrameMs ? Math.min(0.1, (nowMs - lastFrameMs) / 1000) : 0;
    lastFrameMs = nowMs;
    elapsed += dt;
    frameCounter++;

    const target = audio?.amplitude?.() ?? 0;
    amplitude += (target - amplitude) * RENDER.AMPLITUDE_EMA;

    const ready = video.readyState >= 2 && video.videoWidth > 0;
    if (ready) {
      const ts = nowMs;
      segment(video, ts, (mask) => cutter.setMask(mask));
      // Faces move slowly relative to frame rate; halving this buys headroom
      // for the segmenter without any visible lag.
      if (frameCounter % 2 === 0) {
        const found = detectFace(video, ts + 1);
        if (found) faceLandmarks = found;
      }
    }

    clipElapsed += dt;
    if (playable.length > 1 && clipElapsed >= CLIP_SEC - CLIP_TRIM_SEC) {
      loadClip(clipIndex + 1);
    }

    drawBackground();
    // Hearts sit strictly BEHIND the subject -- nothing crosses in front.
    hearts.update(dt, amplitude);
    hearts.draw(ctx, amplitude);
    if (ready) drawSubject(subjectTransform(elapsed));
  }

  return {
    canvas,
    start() {
      if (running) return;
      resetTimestamps();
      cutter.reset();
      hearts.reset();
      faceLandmarks = null;
      elapsed = 0;
      clipElapsed = 0;
      lastFrameMs = 0;
      running = true;
      loadClip(0);
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
      video.pause();
    },
    /**
     * Rewind to the first clip. The engine is started early (during the build)
     * so the reveal is instant rather than stalling on a model load -- but that
     * means clip 1 has already been playing for the whole build by the time
     * anyone sees it. Calling this as the reveal appears means the audience
     * sees stage 1 from its first frame.
     */
    restart() {
      elapsed = 0;
      clipElapsed = 0;
      hearts.reset();
      loadClip(0);
    },
    dispose() {
      this.stop();
      video.removeAttribute('src');
      video.load();
      video.remove();
    },
    get amplitude() { return amplitude; },
    get elapsed() { return elapsed; },
  };
}
