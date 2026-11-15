// Pixel metrics shared by the renderer's exposure guard and the quality
// inspector. Pure functions over RGBA buffers / luma planes — no canvas, so
// every threshold decision is unit-testable in Node.

export const DEFAULT_EXPOSURE_LIMITS = Object.freeze({
  // Average brightness the effects layer may add to / remove from the frame (0–255 luma).
  maxLumaGain: 16,
  maxLumaLoss: 45,
  // Extra share of the frame the effects may push to near-white.
  maxClipGain: 0.03,
  // Inside the subject box: allowed brightness shift and minimum contrast kept.
  maxSubjectLumaShift: 22,
  minSubjectContrast: 0.7
});

const CLIP_LUMA = 245;

export function luma709(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Approximate relative luminance (0..1) from an sRGB luma value (0..255). */
export function relativeLuminance(luma255) {
  return Math.pow(Math.max(0, Math.min(255, luma255)) / 255, 2.2);
}

/** WCAG-style contrast ratio between two relative luminances. */
export function contrastRatio(l1, l2) {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function boxToPixels(box, w, h) {
  if (!box) return { x0: 0, y0: 0, x1: w, y1: h };
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(box.x0 * w)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(box.y0 * h)));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.ceil(box.x1 * w)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.ceil(box.y1 * h)));
  return { x0, y0, x1, y1 };
}

/** Luma plane of an RGBA buffer. */
export function lumaPlane(data, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = luma709(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }
  return out;
}

/**
 * Brightness / clipping / saturation statistics of a frame, optionally limited
 * to a normalised box (e.g. the subject or the caption band).
 */
export function computeFrameStats(data, w, h, { box = null } = {}) {
  const { x0, y0, x1, y1 } = boxToPixels(box, w, h);
  const hist = new Uint32Array(256);
  let sum = 0;
  let sumSq = 0;
  let clip = 0;
  let satSum = 0;
  let satHigh = 0;
  let count = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = luma709(r, g, b);
      sum += l;
      sumSq += l * l;
      hist[Math.min(255, Math.round(l))]++;
      if (l >= CLIP_LUMA) clip++;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      satSum += sat;
      if (sat > 0.85 && mx > 128) satHigh++;
      count++;
    }
  }

  const mean = count ? sum / count : 0;
  const pct = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= count * q) return v;
    }
    return 255;
  };

  return {
    meanLuma: mean,
    stdLuma: count ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : 0,
    clipFrac: count ? clip / count : 0,
    meanSat: count ? satSum / count : 0,
    satHighFrac: count ? satHigh / count : 0,
    lumaP10: pct(0.1),
    lumaP50: pct(0.5),
    lumaP90: pct(0.9),
    lumaP98: pct(0.98)
  };
}

/** Mean absolute luma difference between two planes (0–255). */
export function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Pearson correlation of two luma planes inside a box: 1 = same picture
 * (possibly brighter/darker), near 0 = the structure is gone (washed out or covered).
 */
export function structureCorrelation(a, b, w, h, box = null, { ignoreAbove = Infinity } = {}) {
  const { x0, y0, x1, y1 } = boxToPixels(box, w, h);
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const va = a[i];
      const vb = b[i];
      // Pixels that were replaced outright (an overlay drawn on top) are counted by
      // changedFraction(); here they are skipped so a small bright overlay on a dark,
      // low-contrast subject does not masquerade as "the subject is washed out".
      if (Math.abs(va - vb) > ignoreAbove) continue;
      n++;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  if (n < 16) return 1;
  const cov = sab / n - (sa / n) * (sb / n);
  const varA = saa / n - (sa / n) ** 2;
  const varB = sbb / n - (sb / n) ** 2;
  // A flat reference has no structure to lose.
  if (varA < 1) return 1;
  if (varB < 1e-6) return 0;
  return Math.max(-1, Math.min(1, cov / Math.sqrt(varA * varB)));
}

/** Share of pixels inside a box whose luma differs by more than `threshold` (covered / replaced content). */
export function changedFraction(a, b, w, h, box = null, threshold = 48) {
  const { x0, y0, x1, y1 } = boxToPixels(box, w, h);
  let n = 0;
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      n++;
      if (Math.abs(a[y * w + x] - b[y * w + x]) > threshold) changed++;
    }
  }
  return n ? changed / n : 0;
}

/**
 * Compare a frame with effects against the same frame without them and say by
 * how much the effects exceed the limits. `ratio` > 1 means "too much":
 * dividing the effect layer's opacity by `ratio` brings it back inside.
 */
export function measureEffectExcess(baseStats, fullStats, baseSubject, fullSubject, limits = DEFAULT_EXPOSURE_LIMITS) {
  const lumaDelta = fullStats.meanLuma - baseStats.meanLuma;
  const clipGain = fullStats.clipFrac - baseStats.clipFrac;
  const subjectShift = baseSubject && fullSubject ? Math.abs(fullSubject.meanLuma - baseSubject.meanLuma) : 0;
  // Contrast retention only means something when the subject had contrast to begin with.
  const contrastKept =
    baseSubject && fullSubject && baseSubject.stdLuma > 4 ? Math.min(1.5, fullSubject.stdLuma / baseSubject.stdLuma) : 1;

  const ratio = Math.max(
    lumaDelta > 0 ? lumaDelta / limits.maxLumaGain : -lumaDelta / limits.maxLumaLoss,
    clipGain / limits.maxClipGain,
    subjectShift / limits.maxSubjectLumaShift,
    contrastKept < 1 ? (1 - contrastKept) / (1 - limits.minSubjectContrast) : 0
  );

  return {
    ratio,
    lumaDelta,
    clipGain,
    subjectShift,
    contrastKept
  };
}

/** Median of a numeric array (0 for empty). */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
