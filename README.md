# KINEMA Motion Lab

A webcam motion-capture app that is completely real right up until it isn't.

It tracks your body and hands with on-device machine learning, draws a live skeleton
overlay, and walks you through three "calibration" gestures — recording each one. Then
it builds your result: a progress bar, a serious-sounding status line, and music.

The bar completes exactly on the drop. The screen turns pink. You are dancing.

Everything before that moment is genuinely functional, which is the entire point.

---

## Try it

```bash
git clone <this repo>
cd kinema-motion-lab
node serve.mjs
```

Then open <http://localhost:8080>. No install, no build step, no dependencies.

The MediaPipe runtime and models load from a CDN on first visit. To run fully offline —
worth doing if you are demoing somewhere with bad wifi — fetch them locally once:

```bash
node scripts/fetch-deps.mjs
```

That drops ~40 MB into `vendor/` and `models/`, and the app uses them automatically in
preference to the CDN. `ASSETS.SOURCE` in `src/config.js` can force either path.

`getUserMedia` needs a secure context. `localhost` qualifies, so there is nothing to
configure locally; a deployed copy needs HTTPS.

---

## The music is not included

**You supply your own audio.** Drop a file at `assets/audio/track.mp3`.

Without it the app synthesises a placeholder and still works end to end, so you can try
the whole flow before deciding what to use.

This is deliberate. Using a song in a video you post is one thing — platforms hold
licences with rights holders for exactly that. Shipping the audio file itself inside a
public download is redistribution, which no such licence covers. So this repo does not
contain one, and you should think about what you drop in.

### Landing on the beat

Two numbers in `src/config.js` control the reveal:

```js
AUDIO.DROP_TIME_SEC: 5.2        // where the beat is in your track
AUDIO.BUILD_DURATION_SEC: 3.2   // how long the loading bar takes
```

Playback starts at `DROP_TIME_SEC - BUILD_DURATION_SEC`, so the bar always covers the
final run-up and completes exactly on the beat. Lengthen the bar and it reaches further
back into the track rather than moving the landing point.

To find your drop: press **backtick** on the build screen for a live timestamp and a TAP
button. To verify it: open `/dev.html` and run a timed pass.

#### Why it cannot drift

Progress is read from audio playback position, never from a wall clock:

```js
const p = audio.currentTime() / audio.buildDuration;
```

A timer would slip the moment the main thread stalls and the reveal would miss the beat.
Reading the audio position means a hitched frame simply catches up. Measured drift
between wall clock and audio position across a full pass: **2 ms**.

If audio fails to start at all, a watchdog hands the bar to the wall clock after 1.5 s so
the reveal still fires — silent, but it happens. A bar frozen at 0% right before the
punchline is the worst outcome this screen can produce, so it is designed out.

---

## The three stages

Each runs **intro → place → practice → hold → take**.

| # | Hands | Start | Motion | Face |
|---|---|---|---|---|
| 1 | Open, fingers spread, palms toward you | Beside your ears | Down and back up | Smile |
| 2 | Fists, palms toward you | At your cheeks | Down to meet under your chin, back out | Frown |
| 3 | Fists together | Just under your mouth | Down and back up | Smile |

One ring shows where your hands go now; a trail of beads shows where they go next. The
practice rep is self-paced. The filmed take is metronome-driven — the dot moves and you
follow — which is what makes all three clips identical in length without any editing.

The expression prompt is display only. It is never detected and never blocks anything.

### It will not get stuck

The most likely failure is somebody who cannot hit a pose standing in front of a ring
that refuses to fill. So thresholds loosen after 20 s, the phase passes on its own at
30 s, and `]` force-advances. The failsafes advance the *phase*, not the stage, so
somebody who struggles still produces a usable clip.

---

## Privacy

All inference runs locally in your browser via WebAssembly. No video, image or landmark
data is transmitted anywhere — there is no server to transmit it to. Recordings are
in-memory blobs, and **Clear session data** on the final screen revokes them and stops
the camera.

The consent screen says all of this, and it is true rather than set dressing.

That said: this points a camera at someone and records them. Be decent about it. Show
people the result, and delete it if they would rather you did.

---

## How it holds up

The illusion works because almost nothing about it is fake:

- the skeleton overlay is real MediaPipe tracking — 33 body + 21×2 hand landmarks
- the inference latency in the HUD is measured with `performance.now()` around the
  detect call
- the camera name in the boot log comes from `enumerateDevices()`
- the WASM SIMD line is a real capability check
- the recorder state and byte count are read off the live `MediaRecorder`

Only the framing is a joke.

---

## Tuning

Everything adjustable lives in `src/config.js`.

| | |
|---|---|
| `CHOREO` | timing — cycle length, hold, lead, tail |
| `STAGES` | the choreography itself, in torso-relative units |
| `TARGETS` | ring size and placement, per-stage scale |
| `DETECT` | thresholds, failsafes, hand-point bias |
| `RENDER` | the reveal — background, hearts, kawaii filter |
| `COPY` | every user-facing string |

Positions are expressed in multiples of shoulder width, so they hold whether you are
close to the camera or across the room.

```bash
node scripts/test-targets.mjs
```

35 headless checks over the geometry, occupancy, timing and hand tracking — useful
because that logic is otherwise only testable by standing in front of a webcam.

---

## Licence

None. All rights reserved.

You are welcome to clone this and run it — that is what it is doing here. But no
licence is granted, so this is not open source in the formal sense: forking it,
redistributing it, or building something else on top of it is not covered. Ask
me if you want to do any of that; the answer is probably yes.

Built with [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe),
which carries its own Apache 2.0 licence and is loaded at runtime rather than
bundled here.

### No audio ships with this

No music is included in or distributed with this project. The app expects a
user-supplied file at `assets/audio/track.mp3` and synthesises a placeholder
when none is present. Whatever you supply remains subject to its own rights.
