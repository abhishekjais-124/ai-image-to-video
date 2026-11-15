// 100% In-House, Zero-API-Key Visual Analysis, Prompt Interpreter & Multi-Model Scene Director
// Compatible with Browser, Antigravity, Claude Desktop, and Codex workflows.

import { FACT_PRESETS, seededRandom } from '../presets/fact-presets.js';
import { CHARACTER_ACTION_IDS } from '../engine/character.js';
import { planTimeline } from '../engine/director.js';

export const INHOUSE_MODELS = [
  {
    id: 'saliency-vision',
    name: 'Saliency Vision',
    defaultPreset: 'documentary-kenburns',
    description:
      'Analyzes pixel contrast, luminance, and color warmth to detect the subject focal point and adds a soft anamorphic focal glow.'
  },
  {
    id: 'viral-hook-v1',
    name: 'Viral Hook',
    defaultPreset: '3d-perspective-tilt',
    description:
      'High-retention Shorts pacing: energetic camera push toward the subject, animated focal callout pulse, and retention progress bar.'
  },
  {
    id: 'cinematic-doc-v1',
    name: 'Cinematic Documentary',
    defaultPreset: 'vintage-film-grain',
    description:
      'Tripod-grade pull-back reveal with warm golden dust motes, subtle documentary frame stamp, and soft filmic grading.'
  },
  {
    id: 'mystery-noir-v1',
    name: 'Mystery Noir',
    defaultPreset: 'mystery-fog-shake',
    description:
      'Moody handheld camera sway paired with rolling fog banks, atmospheric rain streaks, and deep shadow pulses.'
  },
  {
    id: 'scifi-neural-v1',
    name: 'Sci-Fi Neural',
    defaultPreset: 'scifi-cyber-glitch',
    description:
      'Futuristic holographic scanlines, RGB chromatic glitch slices, and animated target telemetry around the detected focal point.'
  }
];

export const DEFAULT_ANALYSIS = Object.freeze({
  focusX: 0.5,
  focusY: 0.42,
  subjectBox: { x0: 0.22, y0: 0.2, x1: 0.78, y1: 0.68 },
  details: [{ x: 0.5, y: 0.42, strength: 1 }],
  confidence: 0,
  avgLuminance: 128,
  isDarkScene: false,
  isWarmScene: true,
  accentColor: '255, 225, 155',
  analysed: false
});

function percentile(values, q) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] || 0;
}

/** Summed-area table so any box mean costs four lookups. */
function integralImage(src, w, h) {
  const out = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      out[(y + 1) * (w + 1) + (x + 1)] = out[y * (w + 1) + (x + 1)] + row;
    }
  }
  return out;
}

function boxMean(integral, w, h, x, y, r) {
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(w, x + r + 1);
  const y1 = Math.min(h, y + r + 1);
  const sum =
    integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
  return sum / ((x1 - x0) * (y1 - y0));
}

/**
 * Saliency analysis of an RGBA pixel buffer (pure — unit-testable without a canvas).
 *
 * Combines two cues, both normalised robustly:
 *   • centre–surround colour contrast (a region that differs from its wider surroundings)
 *   • local edge strength
 * and returns the main subject's bounding box, a focal point, the strongest
 * detail points (close-up targets) and the scene's tone. Coordinates are
 * normalised to the source image (0..1).
 */
export function analyzeSaliencyFromPixels(data, w, h) {
  const n = w * h;
  if (!data || n === 0 || data.length < n * 4) return { ...DEFAULT_ANALYSIS };

  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const L = new Float32Array(n);
  let totalLum = 0;
  let totalWarmth = 0;
  let accR = 0, accG = 0, accB = 0, accCount = 0, opaque = 0;

  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    R[i] = r;
    G[i] = g;
    B[i] = b;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    L[i] = lum;
    if (a < 16) continue;
    opaque++;
    totalLum += lum;
    totalWarmth += r - b;
    if (lum > 90 && lum < 245) {
      accR += r;
      accG += g;
      accB += b;
      accCount++;
    }
  }
  if (opaque === 0) return { ...DEFAULT_ANALYSIS };

  const iR = integralImage(R, w, h);
  const iG = integralImage(G, w, h);
  const iB = integralImage(B, w, h);
  const small = Math.max(1, Math.round(Math.min(w, h) * 0.025));
  const large = Math.max(4, Math.round(Math.min(w, h) * 0.24));

  const contrast = new Float32Array(n);
  const edges = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      contrast[i] =
        (Math.abs(boxMean(iR, w, h, x, y, small) - boxMean(iR, w, h, x, y, large)) +
          Math.abs(boxMean(iG, w, h, x, y, small) - boxMean(iG, w, h, x, y, large)) +
          Math.abs(boxMean(iB, w, h, x, y, small) - boxMean(iB, w, h, x, y, large))) / 3;
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
        edges[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]);
      }
    }
  }

  const contrastMax = Math.max(1e-3, percentile(contrast, 0.99));
  const edgeMax = Math.max(1e-3, percentile(edges, 0.99));

  const sal = new Float32Array(n);
  let mean = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const nx = (x + 0.5) / w;
      const ny = (y + 0.5) / h;
      // Mild centre prior: subjects are rarely pressed against the frame edge.
      const prior = Math.max(0.45, 1 - 0.6 * Math.hypot(nx - 0.5, ny - 0.45));
      sal[i] = (0.6 * Math.min(1, contrast[i] / contrastMax) + 0.4 * Math.min(1, edges[i] / edgeMax)) * prior;
      mean += sal[i];
    }
  }
  mean /= n;

  // Keep only what stands out from the image's own baseline.
  let mass = 0;
  const colMass = new Float64Array(w);
  const rowMass = new Float64Array(h);
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = Math.max(0, sal[i] - mean);
      sal[i] = v;
      mass += v;
      colMass[x] += v;
      rowMass[y] += v;
      cx += v * (x + 0.5);
      cy += v * (y + 0.5);
    }
  }

  const tone = {
    avgLuminance: Math.round(totalLum / opaque),
    isDarkScene: totalLum / opaque < 95,
    isWarmScene: totalWarmth / opaque > 15,
    accentColor:
      accCount > 0
        ? `${Math.min(255, Math.round((accR / accCount) * 1.15 + 30))}, ${Math.min(255, Math.round((accG / accCount) * 1.1 + 25))}, ${Math.min(255, Math.round((accB / accCount) * 1.05 + 15))}`
        : DEFAULT_ANALYSIS.accentColor
  };

  if (mass < 1e-6) {
    // A flat image has no subject: fall back to a centred, conservative framing.
    return { ...DEFAULT_ANALYSIS, ...tone, analysed: true };
  }

  const quantile = (marginal, q) => {
    let acc = 0;
    for (let i = 0; i < marginal.length; i++) {
      acc += marginal[i];
      if (acc >= mass * q) return (i + 0.5) / marginal.length;
    }
    return 1;
  };
  const pad = 0.02;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  let box = {
    x0: clamp01(quantile(colMass, 0.05) - pad),
    y0: clamp01(quantile(rowMass, 0.05) - pad),
    x1: clamp01(quantile(colMass, 0.95) + pad),
    y1: clamp01(quantile(rowMass, 0.95) + pad)
  };
  // Never trust a sliver: a subject box narrower than 18% of the frame is widened around its centre.
  const widen = (lo, hi) => {
    if (hi - lo >= 0.18) return [lo, hi];
    const mid = (lo + hi) / 2;
    const a = clamp01(mid - 0.09);
    return [a, clamp01(a + 0.18)];
  };
  [box.x0, box.x1] = widen(box.x0, box.x1);
  [box.y0, box.y1] = widen(box.y0, box.y1);

  // Detail points: peaks of the smoothed saliency map, kept apart from each other.
  const iS = integralImage(sal, w, h);
  const blurR = Math.max(1, Math.round(Math.min(w, h) * 0.045));
  const peaks = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      peaks.push({ x: (x + 0.5) / w, y: (y + 0.5) / h, v: boxMean(iS, w, h, x, y, blurR) });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const details = [];
  for (const p of peaks) {
    if (details.length >= 3 || p.v < peaks[0].v * 0.45) break;
    if (details.every((d) => Math.hypot(d.x - p.x, d.y - p.y) > 0.2)) {
      details.push({ x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)), strength: Number((p.v / peaks[0].v).toFixed(3)) });
    }
  }

  const area = (box.x1 - box.x0) * (box.y1 - box.y0);
  const round = (v) => Number(v.toFixed(3));

  return {
    // Focal point: the saliency centre of mass, kept away from the frame edge.
    focusX: round(Math.max(0.15, Math.min(0.85, cx / mass / w))),
    focusY: round(Math.max(0.15, Math.min(0.82, cy / mass / h))),
    subjectBox: { x0: round(box.x0), y0: round(box.y0), x1: round(box.x1), y1: round(box.y1) },
    details: details.length ? details : [{ x: round(cx / mass / w), y: round(cy / mass / h), strength: 1 }],
    // Diffuse saliency (subject box ≈ whole frame) means "no clear subject".
    confidence: round(Math.max(0, Math.min(1, 1.15 - area * 1.3))),
    ...tone,
    analysed: true
  };
}

/**
 * Analyse the actual image pixels (browser only — needs a canvas):
 * subject box, focal point, close-up targets, luminance, warmth and accent colour.
 * Outside a browser (CLI scene generation) it returns neutral defaults; the
 * renderer re-analyses the real image at render time.
 */
export function analyzeImagePixels(img) {
  if (typeof document === 'undefined' || !img) {
    return { ...DEFAULT_ANALYSIS };
  }

  const sampleSize = 96;
  const canvas = document.createElement('canvas');
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  try {
    ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
    const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);
    return analyzeSaliencyFromPixels(data, sampleSize, sampleSize);
  } catch (_) {
    // Cross-origin (tainted) images cannot be read back: use safe defaults.
    return { ...DEFAULT_ANALYSIS };
  }
}

/**
 * Parse natural-language prompt for motion, atmosphere, and color overrides.
 */
export function parsePromptDirectives(promptText = '') {
  const p = String(promptText || '').toLowerCase();
  const directives = {};

  if (p.includes('zoom out') || p.includes('pull back') || p.includes('reveal')) {
    directives.zoomStart = 1.22;
    directives.zoomEnd = 1.02;
    directives.motionHint = { type: 'reveal' };
  } else if (p.includes('fast') || p.includes('dramatic') || p.includes('intense')) {
    directives.zoomStart = 1.02;
    directives.zoomEnd = 1.28;
    directives.motionHint = { type: 'push-in', motionScale: 1.3 };
  } else if (p.includes('slow') || p.includes('calm') || p.includes('gentle') || p.includes('subtle')) {
    directives.motionHint = { type: 'hold', motionScale: 0.8 };
  }

  if (p.includes('pan left')) directives.panX = -0.05;
  if (p.includes('pan right')) directives.panX = 0.05;
  if (p.includes('pan left') || p.includes('pan right') || p.includes('pan across')) {
    directives.motionHint = { type: 'pan' };
  }
  if (p.includes('tilt up')) directives.panY = -0.05;
  if (p.includes('tilt down')) directives.panY = 0.05;

  if (p.includes('fog') || p.includes('mist') || p.includes('spooky') || p.includes('mystery')) {
    directives.suggestedPreset = 'mystery-fog-shake';
  } else if (p.includes('glitch') || p.includes('cyber') || p.includes('scifi') || p.includes('tech')) {
    directives.suggestedPreset = 'scifi-cyber-glitch';
  } else if (p.includes('vintage') || p.includes('film') || p.includes('history') || p.includes('retro')) {
    directives.suggestedPreset = 'vintage-film-grain';
  } else if (p.includes('spotlight') || p.includes('3d') || p.includes('rays')) {
    directives.suggestedPreset = '3d-perspective-tilt';
  } else if (p.includes('dust') || p.includes('ken burns')) {
    directives.suggestedPreset = 'documentary-kenburns';
  }

  if (p.includes('cyan') || p.includes('neon')) directives.titleColor = '#22d3ee';
  if (p.includes('red') || p.includes('crimson')) directives.titleColor = '#f87171';
  if (p.includes('emerald') || p.includes('green')) directives.titleColor = '#34d399';
  if (p.includes('gold') || p.includes('amber')) directives.titleColor = '#ffd166';

  directives.hasRain = p.includes('rain') || p.includes('storm');
  directives.hasEmbers = p.includes('fire') || p.includes('ember') || p.includes('spark');

  return directives;
}

/**
 * Generate bespoke Custom Canvas 2D JavaScript code based on the selected In-House Model & Prompt.
 * Ensures that switching models or clicking "Generate Variation" produces visibly different code & visuals.
 */
export function generateModelCustomCanvasCode({
  modelId = 'saliency-vision',
  focusX = 0.5,
  focusY = 0.42,
  accentColor = '255, 225, 155',
  variationSeed = 1,
  promptDirectives = {}
}) {
  if (promptDirectives.hasRain) {
    return `// Model (${modelId}) + Prompt Rain Overlay (30 FPS Deterministic)
const { t, width, height, seededRandom } = params;
const rng = seededRandom(${variationSeed * 77 + 11});
ctx.save();
ctx.strokeStyle = 'rgba(185, 225, 255, 0.42)';
ctx.lineWidth = Math.max(1.5, width / 600);
for (let i = 0; i < 95; i++) {
  const x = ((rng() * width - t * 120) % width + width) % width;
  const speed = 900 + rng() * 600;
  const y = ((rng() * height + t * speed) % height + height) % height;
  const len = 28 + rng() * 32;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 6, y + len);
  ctx.stroke();
}
ctx.restore();`;
  }

  if (promptDirectives.hasEmbers) {
    return `// Model (${modelId}) + Prompt Rising Embers Overlay (30 FPS Deterministic)
const { t, width, height, seededRandom } = params;
const rng = seededRandom(${variationSeed * 53 + 29});
ctx.save();
for (let i = 0; i < 75; i++) {
  const x = ((rng() * width + Math.sin(t * 2 + i) * 35) % width + width) % width;
  const speed = 90 + rng() * 140;
  const y = ((rng() * height - t * speed) % height + height) % height;
  const r = (1.5 + rng() * 3.8) * (width / 1080);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 115, 25, 0.78)';
  ctx.shadowBlur = 14;
  ctx.shadowColor = '#ff4500';
  ctx.fill();
}
ctx.restore();`;
  }

  switch (modelId) {
    case 'viral-hook-v1':
      return `// Viral Shorts Hook Director (Seed #${variationSeed})
// Draws an animated subject focus callout ring + bottom retention progress bar
const { t, progress, width, height, focusX, focusY } = params;
const cx = width * focusX;
const cy = height * focusY;
const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 3.5);
const radius = Math.min(width, height) * (0.14 + pulse * 0.025);

ctx.save();
ctx.strokeStyle = \`rgba(253, 224, 71, \${(0.35 + pulse * 0.35).toFixed(3)})\`;
ctx.lineWidth = Math.max(3, width / 260);
ctx.setLineDash([18, 12]);
ctx.beginPath();
ctx.arc(cx, cy, radius, t * 1.2, t * 1.2 + Math.PI * 2);
ctx.stroke();

// Top retention progress bar
ctx.setLineDash([]);
ctx.fillStyle = 'rgba(253, 224, 71, 0.9)';
ctx.fillRect(0, 0, width * progress, Math.max(8, height * 0.005));
ctx.restore();`;

    case 'cinematic-doc-v1':
      return `// Cinematic Documentary Master (Seed #${variationSeed})
// Draws warm documentary viewfinder corner marks & subtle anamorphic edge glow
const { t, width, height } = params;
ctx.save();
const pad = Math.round(width * 0.055);
const mark = Math.round(width * 0.032);
ctx.strokeStyle = 'rgba(255, 235, 190, 0.38)';
ctx.lineWidth = Math.max(2, width / 540);

// Top-left & Top-right documentary viewfinder ticks
ctx.beginPath();
ctx.moveTo(pad, pad + mark); ctx.lineTo(pad, pad); ctx.lineTo(pad + mark, pad);
ctx.moveTo(width - pad - mark, pad); ctx.lineTo(width - pad, pad); ctx.lineTo(width - pad, pad + mark);
ctx.stroke();

// REC indicator pill
const blink = Math.sin(t * Math.PI * 2) > -0.2;
if (blink) {
  ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
  ctx.beginPath();
  ctx.arc(pad + 14, pad + 26, Math.max(6, width / 160), 0, Math.PI * 2);
  ctx.fill();
}
ctx.restore();`;

    case 'mystery-noir-v1':
      return `// Mystery & True-Crime Director (Seed #${variationSeed})
// Draws cold atmospheric rain streaks & dark forensic vignette pulse
const { t, width, height, seededRandom } = params;
const rng = seededRandom(${variationSeed * 113 + 7});
ctx.save();
ctx.strokeStyle = 'rgba(170, 210, 245, 0.25)';
ctx.lineWidth = Math.max(1.2, width / 720);
for (let i = 0; i < 55; i++) {
  const x = (rng() * width) % width;
  const speed = 750 + rng() * 450;
  const y = ((rng() * height + t * speed) % height + height) % height;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 4, y + 26);
  ctx.stroke();
}
ctx.restore();`;

    case 'scifi-neural-v1':
      return `// Sci-Fi Neural Director (Seed #${variationSeed})
// Draws animated target reticle locked onto the detected subject focal point
const { t, width, height, focusX, focusY } = params;
const cx = width * focusX;
const cy = height * focusY;
const r = Math.min(width, height) * 0.11;

ctx.save();
ctx.translate(cx, cy);
ctx.rotate(t * 0.85);
ctx.strokeStyle = 'rgba(34, 211, 238, 0.55)';
ctx.lineWidth = Math.max(2, width / 450);
ctx.strokeRect(-r, -r, r * 2, r * 2);

ctx.beginPath();
ctx.arc(0, 0, r * 0.45, 0, Math.PI * 1.5);
ctx.stroke();
ctx.restore();`;

    case 'saliency-vision':
    default:
      return `// In-House Saliency Vision v2 (Seed #${variationSeed})
// Soft anamorphic glow on the detected focal point. Drawn as a scaled radial
// gradient (an ellipse that fades to nothing) — never a hard-edged rectangle.
const { t, width, height, focusX, focusY } = params;
const cx = width * focusX;
const cy = height * focusY;
const breathe = 0.9 + 0.1 * Math.sin(t * Math.PI * 1.2);
const radius = width * 0.3 * breathe;

ctx.save();
ctx.translate(cx, cy);
ctx.scale(1, 0.16);
const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
grad.addColorStop(0, 'rgba(${accentColor}, 0.16)');
grad.addColorStop(0.45, 'rgba(${accentColor}, 0.06)');
grad.addColorStop(1, 'rgba(${accentColor}, 0)');
ctx.fillStyle = grad;
ctx.beginPath();
ctx.arc(0, 0, radius, 0, Math.PI * 2);
ctx.fill();
ctx.restore();`;
  }
}

/**
 * The director's timeline for a scene: caption cues, shots cut on phrase
 * boundaries, transitions and emphasis beats. Deterministic for a given
 * text / model / seed / prompt. `wordTimings` ([{ start, end }] per word, in
 * seconds) switches captions from estimated timing to real word sync.
 */
export function planSceneTimeline({ factSubtitle = '', duration = 4, modelId = 'saliency-vision', variationSeed = 1, motionPrompt = '', wordTimings = null }) {
  return planTimeline({
    narration: factSubtitle,
    duration,
    modelId,
    seed: variationSeed,
    wordTimings,
    motionHint: parsePromptDirectives(motionPrompt).motionHint || null
  });
}

/**
 * Generate a complete, editable Scene Plan + model-driven Custom Canvas Code.
 * Supports variation seeds and natural-language prompts so outputs vary per model & run.
 */
export function buildScenePlan({
  img,
  modelId = 'saliency-vision',
  presetId = 'documentary-kenburns',
  aspectRatio = '9:16',
  resolution = '1080p',
  duration = 4,
  factTitle = '',
  factSubtitle = '',
  motionPrompt = '',
  variationSeed = 1,
  autoSelectPreset = false,
  characterAction = null,
  characterEnabled = true,
  cameraMode = 'director',
  captionMode = 'phrases',
  effectIntensity = 1,
  wordTimings = null
}) {
  const analysis = img ? analyzeImagePixels(img) : { ...DEFAULT_ANALYSIS };

  const modelObj = INHOUSE_MODELS.find((m) => m.id === modelId) || INHOUSE_MODELS[0];
  const promptDirectives = parsePromptDirectives(motionPrompt);

  const chosenPresetId =
    promptDirectives.suggestedPreset ||
    (autoSelectPreset ? modelObj.defaultPreset : presetId);

  const presetObj = FACT_PRESETS.find((p) => p.id === chosenPresetId) || FACT_PRESETS[0];
  const base = { ...presetObj.defaults };

  const rng = seededRandom(variationSeed * 997 + modelId.length * 31);
  const varJitter = ( variationSeed > 1 ? (rng() - 0.5) * 0.04 : 0 );

  const panTowardFocusX = Number(((0.5 - analysis.focusX) * 0.14 + varJitter).toFixed(3));
  const panTowardFocusY = Number(((0.45 - analysis.focusY) * 0.14 - varJitter * 0.5).toFixed(3));

  let zoomStart = base.zoomStart;
  let zoomEnd = base.zoomEnd + (variationSeed > 1 ? (rng() - 0.5) * 0.05 : 0);
  let panX = panTowardFocusX || base.panX;
  let panY = panTowardFocusY || base.panY;
  let rotateDeg = Number((base.rotateDeg + (variationSeed > 1 ? (rng() - 0.5) * 0.9 : 0)).toFixed(2));
  let particleCount = base.particleCount;
  let vignetteStrength = base.vignetteStrength;
  let titleColor = '#ffd166';

  if (modelId === 'viral-hook-v1') {
    zoomStart = 1.04;
    zoomEnd = Number((1.24 + varJitter).toFixed(3));
    rotateDeg = Number((-1.2 + varJitter * 8).toFixed(2));
    particleCount = 80;
    vignetteStrength = 0.84;
    titleColor = '#fde047';
  } else if (modelId === 'cinematic-doc-v1') {
    zoomStart = Number((1.18 + Math.abs(varJitter)).toFixed(3));
    zoomEnd = 1.02;
    panX = -panTowardFocusX;
    panY = -panTowardFocusY;
    rotateDeg = 0.25;
    particleCount = 55;
    vignetteStrength = 0.7;
    titleColor = '#fbbf24';
  } else if (modelId === 'mystery-noir-v1') {
    zoomStart = 1.05;
    zoomEnd = Number((1.19 + varJitter).toFixed(3));
    rotateDeg = 0.75;
    particleCount = 50;
    vignetteStrength = 0.88;
    titleColor = '#38bdf8';
  } else if (modelId === 'scifi-neural-v1') {
    zoomStart = 1.03;
    zoomEnd = 1.17;
    rotateDeg = 0;
    particleCount = 60;
    vignetteStrength = 0.78;
    titleColor = '#22d3ee';
  }

  // Character action: model default, overridable by the caller / UI / CLI.
  // viral-hook points, cinematic-doc explains, mystery reacts, others point.
  const modelCharacterAction =
    modelId === 'cinematic-doc-v1' ? 'explain'
    : modelId === 'mystery-noir-v1' ? 'wave-react'
    : 'walk-point';
  const resolvedCharacterAction = CHARACTER_ACTION_IDS.includes(characterAction)
    ? characterAction
    : modelCharacterAction;

  // Apply natural-language prompt overrides if present
  if (promptDirectives.zoomStart !== undefined) zoomStart = promptDirectives.zoomStart;
  if (promptDirectives.zoomEnd !== undefined) zoomEnd = promptDirectives.zoomEnd;
  if (promptDirectives.panX !== undefined) panX = promptDirectives.panX;
  if (promptDirectives.panY !== undefined) panY = promptDirectives.panY;
  if (promptDirectives.titleColor) titleColor = promptDirectives.titleColor;

  const generatedCustomCode = generateModelCustomCanvasCode({
    modelId,
    focusX: analysis.focusX,
    focusY: analysis.focusY,
    accentColor: analysis.accentColor,
    variationSeed,
    promptDirectives
  });

  const timeline = planSceneTimeline({ factSubtitle, duration, modelId, variationSeed, motionPrompt, wordTimings });

  return {
    schemaVersion: '2.0',
    engine: 'inhouse-30fps-1080p',
    // 'director' = shot timeline + saliency-safe framing (default).
    // 'manual'   = the classic single move from zoomStart/zoomEnd/panX/panY/rotateDeg.
    cameraMode,
    // 'phrases' = animated phrase captions from the timeline; 'static' = one fixed card.
    captionMode,
    // Master strength of atmosphere/light effects (0 = none, 1 = default, max 1.5).
    effectIntensity,
    modelId,
    variationSeed,
    presetId: chosenPresetId,
    aspectRatio,
    resolution,
    fps: 30,
    duration,
    totalFrames: Math.round(duration * 30),
    focusX: analysis.focusX,
    focusY: analysis.focusY,
    zoomStart: Number(zoomStart.toFixed(3)),
    zoomEnd: Number(zoomEnd.toFixed(3)),
    panX: Number(panX.toFixed(3)),
    panY: Number(panY.toFixed(3)),
    rotateDeg,
    particleCount,
    vignetteStrength,
    characterEnabled: characterEnabled !== false,
    characterAction: resolvedCharacterAction,
    accentColor: analysis.accentColor,
    titleColor,
    factTitle,
    factSubtitle,
    motionPrompt,
    generatedCustomCode,
    // Saliency is only stored when it came from real pixels; otherwise the
    // renderer analyses the actual image when it prepares the scene.
    saliency: analysis.analysed
      ? { subjectBox: analysis.subjectBox, details: analysis.details, confidence: analysis.confidence }
      : null,
    timeline,
    analysisSummary: {
      avgLuminance: analysis.avgLuminance,
      isDarkScene: analysis.isDarkScene,
      isWarmScene: analysis.isWarmScene
    }
  };
}
