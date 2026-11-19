/**
 * Screen visibility manager.
 *
 * Only one screen is active at a time; whichever is active owns the RAF loop.
 * Transitions go through a short crossfade so nothing snaps.
 */

const FADE_MS = 260;

export function createScreens(root) {
  const screens = new Map();
  for (const el of root.querySelectorAll('[data-screen]')) {
    screens.set(el.dataset.screen, el);
    el.hidden = true;
    el.classList.remove('is-active');
  }

  let current = null;

  return {
    get current() { return current; },

    /** @returns {Promise<void>} resolves once the new screen is fully visible */
    async show(name) {
      const next = screens.get(name);
      if (!next) throw new Error(`Unknown screen "${name}"`);
      if (current === name) return;

      const prev = current ? screens.get(current) : null;
      if (prev) {
        prev.classList.remove('is-active');
        await new Promise((r) => setTimeout(r, FADE_MS));
        prev.hidden = true;
      }

      current = name;
      next.hidden = false;
      // Force a reflow so the class change actually animates.
      void next.offsetHeight;
      next.classList.add('is-active');
      await new Promise((r) => setTimeout(r, FADE_MS));
    },

    el(name) { return screens.get(name); },
  };
}
