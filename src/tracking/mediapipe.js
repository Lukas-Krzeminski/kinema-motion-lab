/**
 * Resolves the MediaPipe runtime and model files.
 *
 * There are two ways this can run and both matter:
 *
 *   local  the files sit in vendor/ and models/, put there by
 *          scripts/fetch-deps.mjs. Nothing touches the network, which is what
 *          you want when demoing on a laptop with unreliable wifi.
 *   cdn    the files come from jsDelivr and Google's model host. Nothing to
 *          download, nothing to commit, so a public deploy stays about a
 *          megabyte instead of forty.
 *
 * ASSETS.SOURCE picks between them; 'auto' probes for the local copy and falls
 * back to the CDN, so the same checkout serves both purposes.
 *
 * The probe result is cached, because a failed fetch is slow and there is no
 * reason to repeat it for every model.
 */

import { ASSETS } from '../config.js';

/** Relative to this module, so it resolves the same wherever it is imported. */
const LOCAL_BUNDLE = '../../vendor/tasks-vision/vision_bundle.mjs';

let resolved = null;

/** Does the vendored bundle actually exist? Asked once. */
async function hasLocalCopy() {
  try {
    const url = new URL(LOCAL_BUNDLE, import.meta.url);
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Loads the vision bundle and returns it along with the paths its models
 * should be fetched from.
 *
 * @returns {Promise<{vision: object, wasmPath: string, models: object, source: string}>}
 */
export async function loadVision() {
  if (resolved) return resolved;

  const wanted = ASSETS.SOURCE;
  const useLocal = wanted === 'local'
    || (wanted === 'auto' && await hasLocalCopy());

  // A static import would pin this to one location, so the choice has to be
  // made at runtime.
  const vision = useLocal
    ? await import(/* @vite-ignore */ new URL(LOCAL_BUNDLE, import.meta.url).href)
    : await import(/* @vite-ignore */ ASSETS.CDN.BUNDLE);

  resolved = {
    vision,
    source: useLocal ? 'local' : 'cdn',
    wasmPath: useLocal ? ASSETS.LOCAL.WASM : ASSETS.CDN.WASM,
    models: useLocal ? ASSETS.LOCAL.MODELS : ASSETS.CDN.MODELS,
  };
  return resolved;
}

/** Where the files ended up coming from, for the boot log. */
export const assetSource = () => resolved?.source ?? 'pending';

/**
 * Landmark connection pairs, normalised to [a, b].
 *
 * MediaPipe ships these as {start, end} objects. Tolerating both shapes means
 * a future version that switches to tuples will not silently blank the
 * overlay. Returns [] until the bundle has loaded, so a draw call that lands
 * early simply skips the edges rather than throwing.
 */
const asPairs = (connections) => (connections ?? []).map(
  (c) => (Array.isArray(c) ? c : [c.start, c.end]));

export const poseConnections = () =>
  asPairs(resolved?.vision?.PoseLandmarker?.POSE_CONNECTIONS);

export const handConnections = () =>
  asPairs(resolved?.vision?.HandLandmarker?.HAND_CONNECTIONS);
