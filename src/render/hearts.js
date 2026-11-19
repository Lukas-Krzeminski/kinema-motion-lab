/**
 * Floating heart particle system.
 *
 * Spawn rate and scale ride the live audio amplitude, so the field reacts to
 * whatever track is supplied rather than to a hardcoded beat map.
 *
 * Hearts are drawn BEHIND the subject (see engine.js), never rotate, and fade
 * in as they climb. Size varies enormously; nothing else varies much.
 */

import { RENDER } from '../config.js';

const H = RENDER.HEARTS;
const rand = (min, max) => min + Math.random() * (max - min);

/**
 * The emoji is rendered ONCE into an offscreen sprite and then blitted per
 * particle. Calling fillText for every heart on every frame is far more
 * expensive than drawImage, and at 80 particles that cost is the difference
 * between a smooth reveal and a stuttering one.
 */
const SPRITE_PX = 256;
let sprite = null;

function heartSprite() {
  if (sprite) return sprite;
  const c = document.createElement('canvas');
  c.width = SPRITE_PX;
  c.height = SPRITE_PX;
  const ctx = c.getContext('2d');
  // Colour emoji fonts, in platform order. The fallback keeps a glyph on
  // screen even where no colour emoji font exists.
  ctx.font = `${Math.floor(SPRITE_PX * 0.8)}px "Segoe UI Emoji", "Apple Color Emoji", ` +
    '"Noto Color Emoji", "Twemoji Mozilla", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(H.GLYPH, SPRITE_PX / 2, SPRITE_PX / 2);
  sprite = c;
  return sprite;
}

export function createHeartField(width, height) {
  /** @type {Array<object>} */
  let particles = [];
  let spawnDebt = 0;

  /**
   * Size uses a squared roll so most hearts stay small and the occasional
   * large one genuinely stands out -- a uniform roll just produces a field of
   * medium hearts.
   */
  const spawn = () => ({
    x: rand(-0.05, 1.05) * width,
    y: height + rand(0, 80),
    size: H.MIN_SIZE + Math.pow(Math.random(), 2) * (H.MAX_SIZE - H.MIN_SIZE),
    rise: rand(H.RISE_MIN, H.RISE_MAX),
    drift: rand(-H.DRIFT, H.DRIFT),
    phase: rand(0, Math.PI * 2),
    alpha: H.ALPHA,
    life: 0,
  });

  /**
   * Start with the field already populated across the full height. The reveal
   * only lasts a few seconds, so filling from the bottom would leave most of
   * it playing against a half-empty frame.
   */
  const preseed = () => {
    particles = [];
    for (let i = 0; i < (H.PRESEED ?? 0); i++) {
      const p = spawn();
      p.y = rand(-0.05, 1.0) * height;
      // Backdate life so the drift phase is not synchronised across them.
      p.life = rand(0, 4);
      particles.push(p);
    }
  };

  return {
    reset() { spawnDebt = 0; preseed(); },

    /**
     * @param {number} dt seconds since last frame
     * @param {number} amplitude 0..1 smoothed audio level
     */
    update(dt, amplitude) {
      spawnDebt += (H.BASE_SPAWN_PER_SEC + H.REACTIVE_SPAWN_PER_SEC * amplitude) * dt;
      while (spawnDebt >= 1 && particles.length < H.MAX) {
        particles.push(spawn());
        spawnDebt -= 1;
      }
      if (spawnDebt > 1) spawnDebt = 1; // do not bank a backlog while at cap

      for (const p of particles) {
        p.life += dt;
        p.y -= p.rise * dt * (0.75 + amplitude * 0.75);
        p.x += Math.sin(p.life * 1.7 + p.phase) * p.drift * dt;
      }
      // Cull generously past the top so the largest sprites are fully gone.
      particles = particles.filter((p) => p.y > -H.MAX_SIZE);
    },

    draw(ctx, amplitude) {
      const img = heartSprite();
      ctx.save();
      for (const p of particles) {
        // Fade in over the climb rather than on a timer, so a heart that rises
        // slowly takes correspondingly longer to arrive.
        const travel = Math.min(1, Math.max(0, (height - p.y) / height));
        const fadeIn = Math.min(1, travel / H.FADE_IN);
        const fadeOut = Math.min(1, Math.max(0, (1 - travel) / H.FADE_OUT));
        const a = p.alpha * fadeIn * fadeOut;
        if (a <= 0.004) continue;

        ctx.globalAlpha = a;
        const s = p.size * (1 + amplitude * 0.18);
        ctx.drawImage(img, p.x - s / 2, p.y - s / 2, s, s);
      }
      ctx.restore();
    },

    get count() { return particles.length; },
  };
}
