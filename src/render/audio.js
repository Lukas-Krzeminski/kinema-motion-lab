/**
 * Audio playback, amplitude analysis, and the synthesized fallback.
 *
 * Both paths expose the same surface -- crucially `currentTime`, which the
 * build screen divides by `buildDuration` to get progress. Because progress is
 * a pure function of audio position rather than a wall clock, a stutter on the
 * main thread can never desync the bar from the beat.
 *
 * Playback begins at DROP_TIME_SEC - BUILD_DURATION_SEC, so a shorter bar just
 * starts the track later and still lands exactly on the beat.
 *
 * The real track is user-supplied and not committed to the repo. When it is
 * absent the synth fallback keeps the whole flow working end to end.
 */

import { AUDIO, startAtSec } from '../config.js';

let ctx = null;
const audioContext = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

/**
 * Unlock audio from a real user gesture.
 *
 * The completion screen auto-advances into the build with no click, so by the
 * time the music needs to start there is no fresh gesture to authorise it.
 * Calling this from the camera-permission click creates and resumes the shared
 * context early; every later call reuses it. Without this the track silently
 * fails to play and the entire reveal dies with no error.
 */
export async function unlockAudio() {
  const ac = audioContext();
  if (ac.state === 'suspended') {
    try { await ac.resume(); } catch { /* retried at play() */ }
  }
  return ac.state;
}

/** Does the configured track actually exist and decode? */
async function trackAvailable(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok && Number(res.headers.get('content-length') ?? 1) > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Synthesized fallback
// ---------------------------------------------------------------------------

const NOTE = (semitonesFromA4) => 440 * Math.pow(2, semitonesFromA4 / 12);

/**
 * Builds a placeholder track with a deliberate structure change at
 * SYNTH_DROP_TIME_SEC, so the reveal still lands on something audible when no
 * mp3 has been supplied. Rendered offline into a buffer -- no live scheduling
 * to drift.
 */
function synthesizeTrack(sampleRate, dropAt) {
  const duration = dropAt + 34;
  const length = Math.ceil(duration * sampleRate);
  const buffer = audioContext().createBuffer(2, length, sampleRate);
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);

  const bpm = 124;
  const beat = 60 / bpm;

  // A minor-ish figure: root, minor third, fifth, octave.
  const bassPattern = [-24, -24, -17, -19];
  const arpPattern = [0, 3, 7, 12, 7, 3];
  const leadPattern = [12, 15, 14, 12, 10, 12, 7, 10];

  const env = (t, attack, decay) =>
    t < 0 ? 0
      : t < attack ? t / attack
        : Math.exp(-(t - attack) / decay);

  const square = (phase) => (Math.sin(phase) >= 0 ? 1 : -1);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const afterDrop = t >= dropAt;
    const beatIndex = Math.floor(t / beat);
    const tInBeat = t - beatIndex * beat;

    let sample = 0;

    // Bass -- present throughout, louder after the drop.
    const bassNote = bassPattern[beatIndex % bassPattern.length];
    sample += square(2 * Math.PI * NOTE(bassNote) * t) *
      env(tInBeat, 0.005, 0.12) * (afterDrop ? 0.26 : 0.17);

    // Arpeggio at eighth notes.
    const eighth = Math.floor(t / (beat / 2));
    const tInEighth = t - eighth * (beat / 2);
    const arpNote = arpPattern[eighth % arpPattern.length] - 12;
    sample += Math.sin(2 * Math.PI * NOTE(arpNote) * t) *
      env(tInEighth, 0.004, 0.07) * (afterDrop ? 0.2 : 0.12);

    // Lead only exists after the drop -- that is the audible "hit".
    if (afterDrop) {
      const leadNote = leadPattern[eighth % leadPattern.length];
      sample += square(2 * Math.PI * NOTE(leadNote) * t) *
        env(tInEighth, 0.006, 0.1) * 0.13;

      // Four-on-the-floor kick.
      const tInKick = t - Math.floor(t / beat) * beat;
      sample += Math.sin(2 * Math.PI * 55 * t) * env(tInKick, 0.001, 0.055) * 0.3;
    }

    // Gentle build into the drop so it does not arrive from nowhere.
    const build = afterDrop ? 1 : 0.55 + 0.45 * Math.min(1, t / Math.max(dropAt, 0.001));
    sample *= build;

    const wobble = Math.sin(2 * Math.PI * 0.7 * t) * 0.02;
    L[i] = Math.max(-1, Math.min(1, sample * (1 - wobble)));
    R[i] = Math.max(-1, Math.min(1, sample * (1 + wobble)));
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   isSynth: boolean, buildDuration: number, startAt: number, duration: number,
 *   play: () => Promise<void>, stop: () => void, enableLoop: () => void,
 *   currentTime: () => number, amplitude: () => number,
 *   stream: () => MediaStream|null,
 * }>}
 */
export async function createAudioEngine() {
  const ac = audioContext();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.72;

  const gain = ac.createGain();
  gain.gain.value = AUDIO.VOLUME;

  // A stream destination lets the exported .webm carry the audio too.
  const streamDest = ac.createMediaStreamDestination?.() ?? null;
  analyser.connect(gain);
  gain.connect(ac.destination);
  if (streamDest) gain.connect(streamDest);

  const timeData = new Uint8Array(analyser.fftSize);
  const amplitude = () => {
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    // RMS of a busy mix sits well under 1; scale so the visuals actually move.
    return Math.min(1, Math.sqrt(sum / timeData.length) * 3.2);
  };

  const useReal = await trackAvailable(AUDIO.TRACK_URL);

  if (useReal) {
    const el = new Audio(AUDIO.TRACK_URL);
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    const source = ac.createMediaElementSource(el);
    source.connect(analyser);

    await new Promise((resolve) => {
      if (el.readyState >= 2) return resolve();
      el.addEventListener('canplay', resolve, { once: true });
      el.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 4000);
    });

    const startAt = startAtSec(AUDIO.DROP_TIME_SEC);
    return {
      isSynth: false,
      buildDuration: AUDIO.BUILD_DURATION_SEC,
      startAt,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      element: el,
      async play() {
        await ac.resume();
        el.currentTime = startAt;
        gain.gain.cancelScheduledValues(ac.currentTime);
        gain.gain.setValueAtTime(0.0001, ac.currentTime);
        gain.gain.exponentialRampToValueAtTime(
          Math.max(0.0002, AUDIO.VOLUME), ac.currentTime + AUDIO.FADE_IN_SEC);
        await el.play();
      },
      stop() { el.pause(); },
      /**
       * Loop for filming, restarting at the DROP rather than the top.
       *
       * `el.loop` can only rewind to zero, which would replay the quiet intro
       * underneath a video that is already dancing. Seeking on `ended` instead
       * lets each pass restart on the hook.
       *
       * Deliberately NOT set before playback starts: the build bar's progress
       * is `audio.currentTime() / buildDuration`, so a wraparound mid-build
       * would send the bar backwards. Only the reveal turns this on, and by
       * then nothing reads the position any more.
       */
      enableLoop() {
        const from = AUDIO.LOOP_FROM_SEC ?? AUDIO.DROP_TIME_SEC;
        el.loop = false;
        el.addEventListener('ended', () => {
          el.currentTime = Math.min(from, Math.max(0, (el.duration || from) - 0.05));
          el.play().catch(() => { /* nothing else to try */ });
        });
      },
      currentTime: () => el.currentTime - startAt,
      amplitude,
      stream: () => streamDest?.stream ?? null,
    };
  }

  // --- Fallback -----------------------------------------------------------
  const buffer = synthesizeTrack(ac.sampleRate, AUDIO.SYNTH_DROP_TIME_SEC);
  let node = null;
  let startedAt = 0;

  const synthStartAt = startAtSec(AUDIO.SYNTH_DROP_TIME_SEC);
  return {
    isSynth: true,
    buildDuration: AUDIO.BUILD_DURATION_SEC,
    startAt: synthStartAt,
    duration: buffer.duration,
    element: null,
    async play() {
      await ac.resume();
      node = ac.createBufferSource();
      node.buffer = buffer;
      node.connect(analyser);
      gain.gain.cancelScheduledValues(ac.currentTime);
      gain.gain.setValueAtTime(0.0001, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0002, AUDIO.VOLUME), ac.currentTime + AUDIO.FADE_IN_SEC);
      startedAt = ac.currentTime;
      node.start(0, synthStartAt);
    },
    stop() { try { node?.stop(); } catch { /* already stopped */ } },
    enableLoop() {
      if (!node) return;
      // AudioBufferSourceNode can loop a sub-range directly.
      node.loopStart = AUDIO.LOOP_FROM_SEC ?? AUDIO.SYNTH_DROP_TIME_SEC;
      node.loopEnd = buffer.duration;
      node.loop = true;
    },
    currentTime: () => (node ? ac.currentTime - startedAt : 0),
    amplitude,
    stream: () => streamDest?.stream ?? null,
  };
}
