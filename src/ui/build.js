/**
 * Build screen -- the progress bar that lands on the beat.
 *
 * Progress is `audio.currentTime() / audio.buildDuration`, never a wall clock.
 * A wall-clock timer drifts the moment the main thread stalls (a model decode,
 * a GC pause) and the reveal misses the drop. Reading the audio position
 * instead means a hitched frame simply catches up, and completion always lands
 * at the same point in the track.
 *
 * Playback starts at DROP_TIME_SEC - BUILD_DURATION_SEC, so the bar covers the
 * final run-up to the beat and nothing else.
 */

import { AUDIO, COPY, KEYS } from '../config.js';

export function createBuildScreen({ root, onComplete }) {
  const bar = root.querySelector('[data-build-bar]');
  const titleEl = root.querySelector('[data-build-title]');
  const subEl = root.querySelector('[data-build-sub]');
  const scope = root.querySelector('[data-sync-scope]');
  const scopeTime = root.querySelector('[data-scope-time]');
  const scopeTap = root.querySelector('[data-scope-tap]');
  const scopeTaps = root.querySelector('[data-scope-taps]');

  let audio = null;
  let rafId = 0;
  let done = false;
  let scopeOpen = false;

  // Watchdog state. If audio never starts, the bar must still finish and the
  // reveal must still fire -- a silent hang at the punchline is the single
  // worst outcome this screen can produce.
  let startedWall = 0;
  let stalledAt = null;
  let progressAtStall = 0;
  let audioEverAdvanced = false;
  let lastP = 0;

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
  };

  // --- Sync scope: how DROP_TIME_SEC gets measured -------------------------
  const taps = [];
  const onKey = (e) => {
    if (e.key !== KEYS.SYNC_SCOPE) return;
    scopeOpen = !scopeOpen;
    scope.hidden = !scopeOpen;
  };
  /** Absolute position in the track, which is what DROP_TIME_SEC expresses. */
  const absoluteTime = () => (audio ? audio.currentTime() + (audio.startAt ?? 0) : 0);
  const onTap = () => {
    if (!audio) return;
    taps.unshift(absoluteTime());
    taps.length = Math.min(taps.length, 6);
    scopeTaps.textContent = taps.map((v) => v.toFixed(3)).join('   ');
  };

  /** Grace period before the bar stops waiting for audio to start. */
  const STALL_AFTER_SEC = 1.5;

  function frame() {
    if (done) return;
    rafId = requestAnimationFrame(frame);

    const wall = (performance.now() - startedWall) / 1000;
    const t = audio.currentTime();
    const audioP = Math.min(1, Math.max(0, t / audio.buildDuration));

    if (t > 0.001) audioEverAdvanced = true;

    // Audio position is the source of truth -- it is the only clock that can
    // actually land on the beat. But if playback never starts (a rejected
    // play(), a suspended context, a decode failure) position stays pinned at
    // zero and the bar would hang at 0% forever, which is the worst possible
    // outcome right before the punchline. So fall back to the wall clock.
    if (!audioEverAdvanced && stalledAt === null && wall > STALL_AFTER_SEC) {
      stalledAt = wall;
      progressAtStall = audioP;
      console.warn('[build] audio has not started; driving the bar from the wall clock');
    }

    let p = audioP;
    if (stalledAt !== null) {
      const wallP = Math.min(1, progressAtStall + (wall - stalledAt) / audio.buildDuration);
      // If audio recovers late, hand control back to it -- it is the only
      // thing that can still hit the beat. Take the further of the two so the
      // bar never visibly runs backwards.
      p = audioEverAdvanced ? Math.max(audioP, lastP) : wallP;
    }

    // Monotonic: a bar that jumps backwards reads as broken.
    p = Math.max(p, lastP);
    lastP = p;

    bar.style.width = `${(p * 100).toFixed(2)}%`;
    if (scopeOpen) scopeTime.textContent = fmt(absoluteTime());

    if (p >= 1) {
      done = true;
      cancelAnimationFrame(rafId);
      onComplete();
    }
  }

  return {
    /** @param {object} audioEngine from createAudioEngine() */
    async run(audioEngine) {
      audio = audioEngine;
      done = false;
      bar.style.width = '0%';
      titleEl.textContent = COPY.BUILD_TITLE;
      subEl.textContent = COPY.BUILD_SUB;

      window.addEventListener('keydown', onKey);
      scopeTap?.addEventListener('click', onTap);

      stalledAt = null;
      progressAtStall = 0;
      audioEverAdvanced = false;
      lastP = 0;
      startedWall = performance.now();

      // Start the loop FIRST, then kick off playback. Gating the loop on
      // play() resolving means a rejected or hanging play() leaves the bar
      // frozen at 0% and the reveal never fires at all.
      rafId = requestAnimationFrame(frame);

      // The context was unlocked back at the camera-permission click, so this
      // should not need a fresh gesture -- but if it fails anyway the watchdog
      // above carries the bar to the end regardless.
      audio.play().catch((err) => {
        console.warn('[build] audio play() rejected:', err?.message ?? err);
      });
    },

    stop() {
      done = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKey);
      scopeTap?.removeEventListener('click', onTap);
    },

    /** Shown in the footer so a missing track is obvious during setup. */
    sourceLabel: () =>
      audio?.isSynth
        ? `synthesised placeholder -- drop a file at ${AUDIO.TRACK_URL}`
        : 'source track',
  };
}
