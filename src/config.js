/**
 * Every tunable in the app lives here.
 *
 * The things most likely to need adjusting against reality:
 *   1. AUDIO.DROP_TIME_SEC     -- where the beat is in your track
 *   2. AUDIO.BUILD_DURATION_SEC -- how long the loading bar takes
 *   3. STAGES[n].dots / TARGETS -- where the guide dots sit on the body
 *   4. CHOREO.CYCLE_SEC        -- how fast the filmed reps go
 *
 * Nothing in here requires touching engine code to change.
 */

export const APP = {
  NAME: 'KINEMA',
  SUBTITLE: 'Motion Intelligence Suite',
  VERSION: '4.2.1',
  BUILD: '4400.1527-public',
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const LAYOUT = {
  /**
   * Small dim telemetry strip on the capture screen. It is a big part of why
   * the app reads as a real tool before the reveal, but the brief was
   * "everything else should just be the camera" -- set false to remove it.
   */
  SHOW_TELEMETRY: true,
};

// ---------------------------------------------------------------------------
// Audio + the sync that makes the reveal land on the beat
// ---------------------------------------------------------------------------

export const AUDIO = {
  /** Drop your own file here. Not committed. */
  TRACK_URL: 'assets/audio/track.mp3',

  /**
   * Seconds from the start of the track to the beat the bar must finish on
   * (the "can't wait to meet you" hit).
   *
   * To find it: press the backtick key on the build screen. A sync scope opens
   * with a running timestamp and a TAP button -- tap on the beat, read the
   * number, paste it here.
   *
   * 5.2 was derived from the supplied track's energy envelope: it sits quiet
   * until 5.1s, then jumps to full level within 200ms and stays there. That is
   * the intro-to-hook transition. Confirm it by ear with the sync scope --
   * energy analysis finds the structural change, not the specific lyric.
   */
  DROP_TIME_SEC: 5.2,

  /**
   * How long the loading bar takes. Playback starts at
   * DROP_TIME_SEC - BUILD_DURATION_SEC so the bar still completes exactly on
   * the beat -- these two numbers are the only ones that matter, and the start
   * offset is derived rather than tuned separately.
   */
  BUILD_DURATION_SEC: 3.2,

  /**
   * Where the track loops back to during the reveal.
   *
   * null means the drop, so every pass restarts on the hook instead of
   * replaying the quiet intro under a video that is already going. Set to 0 to
   * loop the whole song from the top.
   */
  LOOP_FROM_SEC: null,

  FADE_IN_SEC: 0.25,
  VOLUME: 0.85,

  /** Drop time for the synthesized placeholder used when no track is present. */
  SYNTH_DROP_TIME_SEC: 13.5,
};

/** Where playback begins, so the bar covers exactly BUILD_DURATION_SEC. */
export const startAtSec = (dropTime) =>
  Math.max(0, dropTime - AUDIO.BUILD_DURATION_SEC);

// ---------------------------------------------------------------------------
// Where the MediaPipe runtime and models come from
// ---------------------------------------------------------------------------

export const ASSETS = {
  /**
   * 'auto'  use vendor/ and models/ if they are present, otherwise the CDN
   * 'local' force the vendored copies (offline; run scripts/fetch-deps.mjs)
   * 'cdn'   force the CDN (nothing to download, needs network on first load)
   *
   * 'auto' means one checkout serves both a public deploy and an offline demo.
   */
  SOURCE: 'auto',

  LOCAL: {
    WASM: 'vendor/tasks-vision/wasm',
    MODELS: {
      pose: 'models/pose_landmarker_lite.task',
      hand: 'models/hand_landmarker.task',
      face: 'models/face_landmarker.task',
      segmenter: 'models/selfie_segmenter.tflite',
    },
  },

  CDN: {
    BUNDLE: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs',
    WASM: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
    MODELS: {
      pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      segmenter: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
    },
  },
};

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export const CAPTURE = {
  VIDEO: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },

  /** Mirror the preview. Feels natural to the subject; undone before render. */
  MIRROR_PREVIEW: true,

  MIME_CANDIDATES: [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ],

  VIDEO_BITS_PER_SECOND: 4000000,
};

// ---------------------------------------------------------------------------
// Choreography timing
// ---------------------------------------------------------------------------

/**
 * The timing model.
 *
 * PRACTICE is self-paced: hit the top dot, hold, drop to the bottom dot, hold,
 * come back. That teaches the shape of the move.
 *
 * FILMING is NOT self-paced. The dot moves on a strict clock and the subject
 * follows it, which is what makes all three movements land exactly on time and
 * look deliberately robotic.
 *
 * The earlier user-led version had a real flaw: the recording window was fixed
 * but the movement was not, so somebody moving slower than the window got only
 * the first couple of reps into their clip.
 */
export const CHOREO = {
  PRACTICE_REPS: 1,
  FILMED_CYCLES: 3,
  CYCLE_SEC: 1.0,

  /**
   * A beat between the practice rep and the filmed take, where the dot sits at
   * the starting position and the card counts down.
   *
   * Nothing is recorded yet, so this does not lengthen the clip. Its job is to
   * make it obvious that fast movement is about to start -- without the
   * warning people were still settling when the dot took off, and the first
   * moment of every clip came out flat.
   */
  SETTLE_SEC: 1.8,

  /**
   * Recording starts LEAD_SEC before the dot moves and stops TAIL_SEC after it
   * finishes. MediaRecorder does not begin capturing the instant it is told
   * to, so without a lead the first movement is clipped off the front.
   *
   * The lead sits INSIDE the settle, not at the front of the take: the
   * recorder warms up while the subject is still holding still, so the dot
   * begins moving at the exact moment the hold bar fills. Putting the lead
   * after the hold instead made the take visibly start early.
   */
  LEAD_SEC: 0.15,
  TAIL_SEC: 0.3,

  /** Fraction of the window after which the urgency styling kicks in. */
  URGENCY_FROM: 0.55,

  /**
   * A beat at the start of each stage where the new instructions are shown over
   * the live camera and NOTHING is detected.
   *
   * Without it, whatever pose the subject is still holding from the previous
   * stage immediately satisfies the next stage's start ring -- so the stage
   * advances before anyone has read what it is asking for.
   */
  STAGE_INTRO_SEC: 8,
};

/** How long the dot is actually moving. */
export const FILMED_SEC = CHOREO.FILMED_CYCLES * CHOREO.CYCLE_SEC;

/**
 * Length of each recorded clip, and therefore of each third of the final
 * video. The lead and tail are part of the clip, so playback must use THIS,
 * not FILMED_SEC -- using the shorter value cuts the end off every clip.
 */
export const CLIP_SEC = CHOREO.LEAD_SEC + FILMED_SEC + CHOREO.TAIL_SEC;

/**
 * How long the FILMING phase itself runs. The lead has already elapsed during
 * the settle by the time it starts, so the phase covers the motion plus the
 * tail only.
 */
export const TAKE_SEC = FILMED_SEC + CHOREO.TAIL_SEC;

/**
 * Seconds shaved off the FRONT of each clip during playback.
 *
 * The recorder is armed LEAD_SEC before the dot moves so MediaRecorder is warm
 * and no movement is clipped -- but that lead, plus the moment of human
 * reaction after the dot departs, is dead air at the start of every clip.
 * Trimming it at playback means the recording stays safe while the video opens
 * on actual movement.
 *
 * Raising this past LEAD_SEC eats into real motion, so keep the margin small.
 */
export const CLIP_TRIM_SEC = CHOREO.LEAD_SEC + 0.12;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export const DETECT = {
  /** How long the start position must be held before the motion begins. */
  HOLD_SEC: 0.9,

  CONFIDENCE_EMA: 0.25,
  MATCH_THRESHOLD: 0.7,

  /**
   * Failsafe. The likeliest way this dies is somebody who cannot hit a pose
   * standing there while a ring refuses to fill.
   */
  RELAX_AFTER_SEC: 20,
  RELAX_FLOOR: 0.55,
  AUTOPASS_SEC: 30,

  MIN_VISIBILITY: 0.42,

  /**
   * How far from the wrist joint toward the knuckles the test point sits.
   * 0 = the wrist landmark, 1 = the knuckle line. The wrist is several inches
   * below the visible hand, so testing it directly biases every zone low.
   */
  HAND_POINT_BIAS: 0.65,
};

// ---------------------------------------------------------------------------
// Target geometry
// ---------------------------------------------------------------------------

/**
 * All offsets and radii are in TORSO UNITS (multiples of shoulder width), so
 * everything holds whether the subject is close to the camera or across the
 * room. Vertical offsets are aspect-corrected in targets.js.
 */
export const TARGETS = {
  RADIUS: 0.28,
  /** Slightly smaller for the moving dots than for the start rings. */
  DOT_RADIUS: 0.22,
  /** Exit radius multiplier, so a wrist on a boundary does not flicker. */
  HYSTERESIS: 1.34,

  /**
   * For a shared ring, how far apart the two wrists may be (in ring radii) and
   * still count as "hands together". Testing each wrist separately made the
   * joined-fists stage flicker whenever one wrist landmark drifted.
   */
  TOGETHER_SPREAD: 1.6,

  /**
   * Anchor points on the body that each stage's dots hang from.
   *   fromEar  horizontal offset outward from the ear
   *   dy       vertical offset, positive is downward
   *   center   anchor on the body midline instead of per-hand
   */
  ANCHORS: {
    // Separated rings hang off either the EAR (pushed outward) or the NOSE
    // (pushed out from the midline). Cheeks use the nose, because measuring
    // outward from the ear put them well wide of the head.
    ear:   { fromEar: 0.52, dy: -0.08 },
    cheek: { fromNose: 0.26, dy: 0.20 },
    // Chin height. The ring CENTRE is where the fists go, so centring on the
    // chin keeps the hands below the mouth and the smile visible -- the ring
    // outline passing near the mouth does not matter, only the hands do.
    mouth: { fromEar: 0.30, dy: 0.32 },
  },
};

// ---------------------------------------------------------------------------
// The three stages
// ---------------------------------------------------------------------------

/**
 * Each stage is: a hand shape, palms toward the subject, an anchor on the
 * body, a two-dot up/down motion, and an expression prompt.
 *
 * `dots.high` / `dots.low` are vertical offsets from the anchor in torso
 * units. Negative is up.
 *
 * Hand shape and palm direction are SCORED and shown in the left overlay, but
 * never gate a stage -- the failsafes stay the only forced path through.
 */
export const STAGES = [
  {
    id: 'ears',
    stage: 1,
    title: 'Bilateral Marker Alignment',
    anchor: 'ear',
    /** Slightly forgiving -- open hands beside the head track less cleanly. */
    radiusScale: 1.15,
    // `shape` drives the hand-shape SCORING; `icon` only picks the picture,
    // so the two fist stages can score identically but look different.
    hand: { shape: 'open', icon: 'open', label: 'OPEN HANDS',
            detail: 'Fingers spread, palms toward you' },
    expression: { icon: 'smile', label: 'SMILE' },
    /**
     * Each position is { dy, together }. `dy` is a vertical offset from the
     * anchor in torso units, negative being up. `together` puts a single
     * shared ring on the midline that BOTH wrists must reach.
     *
     * `high` sits level with the start, so the motion drops away from the ears
     * and returns -- starting the sequence on a dot they are already standing
     * in would give them nothing to do.
     */
    positions: {
      start: { dy: 0, together: false },
      high: { dy: 0, together: false },
      low: { dy: 0.58, together: false },
    },
    /** Down first, then back up. */
    sequence: ['low', 'high'],
    place: {
      instruction: 'Put both hands in the markers beside your head',
      hint: 'Palms facing you, fingers spread apart',
    },
    practice: { instruction: 'Hit the dots', hint: 'Follow the trail down, then back up' },
    filming: { instruction: 'Follow the dot', hint: 'Move with it, stay on the beat' },
  },
  {
    id: 'cheeks',
    stage: 2,
    title: 'Range-of-Motion Sweep',
    anchor: 'cheek',
    /**
     * More forgiving zones than the other stages. Fists at the cheeks sit
     * close together and the wrist landmark lands behind the hand, so the
     * default radius made this one fiddly to register.
     */
    radiusScale: 1.3,
    hand: { shape: 'fist', icon: 'fist', label: 'FISTS',
            detail: 'Closed fists, palms toward you' },
    expression: { icon: 'frown', label: 'FROWN' },
    /**
     * A U shape: fists apart at the cheeks, down to meet under the chin, back
     * out to the cheeks. The low position is `together`, the high one is not --
     * which is why positions carry the flag rather than the stage.
     */
    positions: {
      start: { dy: 0, together: false },
      high: { dy: -0.06, together: false },
      low: { dy: 0.34, together: true },
    },
    sequence: ['low', 'high'],
    place: {
      instruction: 'Make fists and bring them to your cheeks',
      hint: 'Palms still facing you, hands apart',
    },
    practice: { instruction: 'Hit the dots', hint: 'Down together under your chin, then back out' },
    filming: { instruction: 'Follow the dot', hint: 'Move with it, stay on the beat' },
  },
  {
    id: 'mouth',
    stage: 3,
    title: 'Directional Vector Calibration',
    anchor: 'mouth',
    hand: { shape: 'fist', icon: 'fist-side', label: 'FISTS TOGETHER',
            detail: 'Fists joined, palms together' },
    expression: { icon: 'smile', label: 'SMILE' },
    /**
     * Kept below the mouth so the smile stays visible the whole way through.
     *
     * The drop is deliberately small -- the low ring sits just under the high
     * one rather than down at the waist, so this reads as a tight bob rather
     * than a big reach.
     */
    positions: {
      start: { dy: 0, together: true },
      high: { dy: 0, together: true },
      // Far enough that it reads as a distinct second circle below the first
      // rather than the same one nudged -- at 0.38 "GO DOWN" barely moved it.
      low: { dy: 0.58, together: true },
    },
    sequence: ['low', 'high'],
    place: {
      instruction: 'Put your fists together just under your mouth',
      hint: 'Both hands joined, low enough to keep your smile visible',
    },
    practice: { instruction: 'Hit the dots', hint: 'Down, then back up under your mouth' },
    filming: { instruction: 'Follow the dot', hint: 'Move with it, stay on the beat' },
  },
];

/** Hand-shape scoring. Openness is mean fingertip distance / palm length. */
export const HAND_SHAPE = {
  FIST_MAX: 1.15,
  OPEN_MIN: 1.45,
};

/**
 * Palm-facing sign. 2D chirality flips with palm direction and again with
 * handedness. If the indicator reads backwards on your hardware, flip to -1.
 */
export const PALM_INWARD_SIGN = 1;

// ---------------------------------------------------------------------------
// Render / reveal
// ---------------------------------------------------------------------------

export const RENDER = {
  WIDTH: 1280,
  HEIGHT: 720,

  SWEEP: {
    BPM: 124,
    BEATS_PER_SWEEP: 8,
    AMPLITUDE: 0.22,
    BOUNCE_PX: 26,
    SCALE: 1.05,
  },

  /** Flat pink. No gradient, no sunburst -- the subject is the subject. */
  BACKGROUND: { COLOR: '#ff5fb2' },

  /**
   * Hearts live strictly behind the subject and never rotate.
   *
   * Size varies enormously and deliberately -- a squared roll keeps most of
   * them small so the occasional huge one actually reads as huge. Everything
   * else is uniform, because varying colour and opacity too made the field
   * look like confetti rather than one backdrop.
   */
  HEARTS: {
    /**
     * U+1F497 GROWING HEART -- the solid pink heart ringed by two lighter
     * outlines. Escaped rather than literal so the source stays ASCII, and
     * drawn from the system emoji font so it arrives with a transparent
     * background and needs no image asset.
     */
    GLYPH: '\u{1F497}',

    /** Fewer on screen than before, so they read as spaced rather than packed. */
    MAX: 46,
    BASE_SPAWN_PER_SEC: 7,
    REACTIVE_SPAWN_PER_SEC: 11,

    MIN_SIZE: 22,
    MAX_SIZE: 210,

    RISE_MIN: 150,
    RISE_MAX: 265,
    DRIFT: 14,
    ALPHA: 0.92,

    /**
     * Seed this many hearts at random heights the moment the field starts.
     * Without it the reveal opens on an empty frame and takes several seconds
     * to fill from the bottom -- but the reveal is only ever a few seconds
     * long, so it would spend most of its life half empty.
     */
    PRESEED: 30,

    /** Fraction of the climb spent fading in. */
    FADE_IN: 0.22,
    /** Short fade at the very top so nothing clips against the edge. */
    FADE_OUT: 0.12,
  },

  KAWAII: {
    BLUSH_ALPHA: 0.45,
    BLUSH_SCALE: 0.36,
    BLUSH_COLOR: '#ff5c9e',
    SPARKLE_COUNT: 3,
    CAT_EARS: true,
    EAR_COLOR: '#ff6fb5',
    EAR_INNER: '#ffd5ea',
    EAR_SCALE: 0.42,
  },

  AMPLITUDE_EMA: 0.18,
};

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const COPY = {
  CONSENT_TITLE: 'Camera access required',
  CONSENT_BODY:
    'This session captures short video segments to compute a kinematic model of your ' +
    'upper body. All inference runs locally in this browser using on-device WebAssembly ' +
    'models. No video, image or landmark data is transmitted to any server.',
  CONSENT_NOTE: 'Captured segments are held in memory only and are discarded when this tab closes.',
  CONSENT_ACTION: 'Enable camera',

  COMPLETE_TITLE: 'MOTION CAPTURE COMPLETE',

  /** Shown during the settle beat, right before the dot starts moving. */
  SETTLE_INSTRUCTION: 'Get ready to move',
  SETTLE_HINT: 'The dot moves fast - follow it',

  /** Build screen: one line on top, "building..." underneath. */
  BUILD_TITLE: 'Rendering personalised output',
  BUILD_SUB: 'building...',
};

/** How long MOTION CAPTURE COMPLETE holds before the build starts. */
export const COMPLETE_HOLD_MS = 1100;

/** Hidden operator keys. */
export const KEYS = {
  FORCE_ADVANCE: ']',
  SYNC_SCOPE: '`',
};
