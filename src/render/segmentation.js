/**
 * Turns the selfie segmenter's category mask into a soft-edged person cutout.
 *
 * The mask is small (model resolution, not video resolution), so the only
 * per-pixel JS runs over the mask itself. Compositing the cutout is done with
 * canvas composite ops, which stay on the GPU.
 *
 * Two safeguards, because a wrong mask means the subject disappears entirely
 * at the exact moment the reveal needs to land:
 *   1. Which category means "person" is detected from the frame corners
 *      rather than assumed, so an inverted model cannot flip the cutout.
 *   2. A mask selecting almost none (or almost all) of the frame is treated
 *      as unreliable and the raw frame is shown instead.
 */

/** Mask coverage outside this range is treated as a bad segmentation. */
const MIN_COVERAGE = 0.02;
const MAX_COVERAGE = 0.985;

export function createCutter(width, height) {
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d');

  let maskImage = null;
  let haveMask = false;
  let coverage = 0;

  /**
   * In any webcam framing the frame corners are background, so whichever
   * category dominates them is background and the other is the subject.
   * Sampling a small patch at each corner rather than a single pixel keeps
   * this stable against noise at the mask edge.
   */
  function backgroundCategory(data, mw, mh) {
    const patch = Math.max(2, Math.floor(Math.min(mw, mh) * 0.06));
    const tally = new Map();
    const corners = [[0, 0], [mw - patch, 0], [0, mh - patch], [mw - patch, mh - patch]];
    for (const [cx, cy] of corners) {
      for (let y = cy; y < cy + patch; y++) {
        for (let x = cx; x < cx + patch; x++) {
          const v = data[y * mw + x];
          tally.set(v, (tally.get(v) ?? 0) + 1);
        }
      }
    }
    let best = 0, bestCount = -1;
    for (const [v, n] of tally) {
      if (n > bestCount) { best = v; bestCount = n; }
    }
    return best;
  }

  return {
    canvas: outCanvas,

    /**
     * Consume a MediaPipe MPMask. Must be called synchronously inside the
     * segmenter callback -- the mask is freed when that callback returns.
     */
    setMask(mpMask) {
      if (!mpMask) return;
      const mw = mpMask.width, mh = mpMask.height;
      const data = mpMask.getAsUint8Array();
      if (!data?.length) return;

      if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
        maskCanvas.width = mw;
        maskCanvas.height = mh;
        maskImage = maskCtx.createImageData(mw, mh);
      }

      const bg = backgroundCategory(data, mw, mh);

      // White + opaque where the subject is, fully transparent elsewhere.
      const px = maskImage.data;
      let on = 0;
      for (let i = 0, p = 0; i < data.length; i++, p += 4) {
        const isSubject = data[i] !== bg;
        if (isSubject) on++;
        px[p] = px[p + 1] = px[p + 2] = 255;
        px[p + 3] = isSubject ? 255 : 0;
      }

      coverage = on / data.length;
      if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) {
        // Nothing usable found -- keep whatever matte we had rather than
        // replacing a good one with an empty frame.
        return;
      }

      maskCtx.putImageData(maskImage, 0, 0);
      haveMask = true;
    },

    /**
     * Composites `source` through the current mask into `canvas`.
     * Falls back to the raw frame until a usable mask arrives, so the subject
     * is never invisible.
     */
    cut(source) {
      outCtx.setTransform(1, 0, 0, 1, 0, 0);
      outCtx.globalCompositeOperation = 'source-over';
      outCtx.clearRect(0, 0, width, height);
      outCtx.drawImage(source, 0, 0, width, height);

      if (!haveMask) return outCanvas;

      // Blur softens the hard model edge into something that reads as a matte.
      outCtx.globalCompositeOperation = 'destination-in';
      outCtx.filter = 'blur(2px)';
      outCtx.drawImage(maskCanvas, 0, 0, width, height);
      outCtx.filter = 'none';
      outCtx.globalCompositeOperation = 'source-over';
      return outCanvas;
    },

    /** Exposed for debugging a bad cutout. */
    get coverage() { return coverage; },
    get hasMask() { return haveMask; },

    reset() { haveMask = false; coverage = 0; },
  };
}
