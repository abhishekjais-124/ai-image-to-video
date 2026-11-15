// 100% In-House, Zero-API-Key Visual Analysis, Prompt Interpreter & Multi-Model Scene Director
// Compatible with Browser, Antigravity, Claude Desktop, and Codex workflows.

import { FACT_PRESETS, seededRandom } from '../presets/fact-presets.js';

export const INHOUSE_MODELS = [
  {
    id: 'saliency-vision',
    name: 'In-House Saliency Vision v1 (Auto Focus + Lens Flare)',
    defaultPreset: 'documentary-kenburns',
    description:
      'Analyzes pixel contrast, luminance, and color warmth to detect the subject focal point and adds a soft anamorphic focal glow.'
  },
  {
    id: 'viral-hook-v1',
    name: 'Viral Shorts Hook Director (Fast Push + Focus Ring + Progress Bar)',
    defaultPreset: '3d-perspective-tilt',
    description:
      'High-retention Shorts pacing: energetic camera push toward the subject, animated focal callout pulse, and retention progress bar.'
  },
  {
    id: 'cinematic-doc-v1',
    name: 'Cinematic Documentary Master (Slow Reveal + Film Letterbox)',
    defaultPreset: 'vintage-film-grain',
    description:
      'Tripod-grade pull-back reveal with warm golden dust motes, subtle documentary frame stamp, and soft filmic grading.'
  },
  {
    id: 'mystery-noir-v1',
    name: 'Mystery & True-Crime Director (Handheld + Mist + Rain)',
    defaultPreset: 'mystery-fog-shake',
    description:
      'Moody handheld camera sway paired with rolling fog banks, atmospheric rain streaks, and deep shadow pulses.'
  },
  {
    id: 'scifi-neural-v1',
    name: 'Sci-Fi Neural Director (Cyber Glitch + Telemetry HUD)',
    defaultPreset: 'scifi-cyber-glitch',
    description:
      'Futuristic holographic scanlines, RGB chromatic glitch slices, and animated target telemetry around the detected focal point.'
  }
];

/**
 * Inspect actual image pixels on a 96x96 offscreen canvas to find:
 * - High-contrast / salient focal point (focusX, focusY)
 * - Average luminance & color warmth
 * - Dominant highlight RGB for particles/lighting
 */
export function analyzeImagePixels(img) {
  if (typeof document === 'undefined' || !img) {
    return {
      focusX: 0.5,
      focusY: 0.42,
      avgLuminance: 128,
      isDarkScene: false,
      isWarmScene: true,
      accentColor: '255, 225, 155'
    };
  }

  const sampleSize = 96;
  const canvas = document.createElement('canvas');
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  try {
    ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
    const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);

    let totalLum = 0;
    let totalWarmth = 0;
    let weightSum = 0;
    let weightedX = 0;
    let weightedY = 0;

    let accR = 0;
    let accG = 0;
    let accB = 0;
    let accCount = 0;

    const lumAt = (x, y) => {
      const idx = (y * sampleSize + x) * 4;
      return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    };

    for (let y = 1; y < sampleSize - 1; y++) {
      for (let x = 1; x < sampleSize - 1; x++) {
        const idx = (y * sampleSize + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];
        if (a < 16) continue;

        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        totalLum += lum;
        totalWarmth += r - b;

        const gx = Math.abs(lumAt(x + 1, y) - lumAt(x - 1, y));
        const gy = Math.abs(lumAt(x, y + 1) - lumAt(x, y - 1));
        const edgeStrength = gx + gy;

        const normX = x / sampleSize;
        const normY = y / sampleSize;
        const centerBias = 1.0 - 0.65 * Math.hypot(normX - 0.5, normY - 0.42);
        const saliency = (edgeStrength * 0.75 + lum * 0.25) * Math.max(0.2, centerBias);

        weightSum += saliency;
        weightedX += normX * saliency;
        weightedY += normY * saliency;

        if (lum > 90 && lum < 245) {
          accR += r;
          accG += g;
          accB += b;
          accCount++;
        }
      }
    }

    const pixelCount = (sampleSize - 2) * (sampleSize - 2);
    const avgLum = totalLum / pixelCount;
    const avgWarmth = totalWarmth / pixelCount;

    const focusX = weightSum > 0 ? Math.max(0.2, Math.min(0.8, weightedX / weightSum)) : 0.5;
    const focusY = weightSum > 0 ? Math.max(0.2, Math.min(0.78, weightedY / weightSum)) : 0.42;

    const accentR = accCount > 0 ? Math.min(255, Math.round((accR / accCount) * 1.15 + 30)) : 255;
    const accentG = accCount > 0 ? Math.min(255, Math.round((accG / accCount) * 1.1 + 25)) : 225;
    const accentB = accCount > 0 ? Math.min(255, Math.round((accB / accCount) * 1.05 + 15)) : 155;

    return {
      focusX: Number(focusX.toFixed(3)),
      focusY: Number(focusY.toFixed(3)),
      avgLuminance: Math.round(avgLum),
      isDarkScene: avgLum < 95,
      isWarmScene: avgWarmth > 15,
      accentColor: `${accentR}, ${accentG}, ${accentB}`
    };
  } catch (_) {
    return {
      focusX: 0.5,
      focusY: 0.42,
      avgLuminance: 128,
      isDarkScene: false,
      isWarmScene: true,
      accentColor: '255, 225, 155'
    };
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
  } else if (p.includes('fast') || p.includes('dramatic') || p.includes('intense')) {
    directives.zoomStart = 1.02;
    directives.zoomEnd = 1.28;
  }

  if (p.includes('pan left')) directives.panX = -0.05;
  if (p.includes('pan right')) directives.panX = 0.05;
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
const cx = width * ${focusX};
const cy = height * ${focusY};
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
const cx = width * ${focusX};
const cy = height * ${focusY};
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
      return `// In-House Saliency Vision v1 (Seed #${variationSeed})
// Draws a soft anamorphic lens flare centered on the detected subject focal point (${focusX}, ${focusY})
const { t, width, height } = params;
const cx = width * ${focusX};
const cy = height * ${focusY};
const breathe = 0.85 + 0.15 * Math.sin(t * Math.PI * 1.5);

ctx.save();
const flareW = width * 0.55 * breathe;
const flareH = Math.max(6, height * 0.008);
const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, flareW * 0.5);
grad.addColorStop(0, 'rgba(${accentColor}, 0.26)');
grad.addColorStop(0.5, 'rgba(${accentColor}, 0.08)');
grad.addColorStop(1, 'rgba(${accentColor}, 0)');
ctx.fillStyle = grad;
ctx.fillRect(cx - flareW * 0.5, cy - flareH * 3, flareW, flareH * 6);
ctx.restore();`;
  }
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
  autoSelectPreset = false
}) {
  const analysis = img
    ? analyzeImagePixels(img)
    : {
        focusX: 0.5,
        focusY: 0.42,
        avgLuminance: 128,
        isDarkScene: false,
        isWarmScene: true,
        accentColor: '255, 225, 155'
      };

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

  return {
    schemaVersion: '1.0',
    engine: 'inhouse-30fps-1080p',
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
    accentColor: analysis.accentColor,
    titleColor,
    factTitle,
    factSubtitle,
    motionPrompt,
    generatedCustomCode,
    analysisSummary: {
      avgLuminance: analysis.avgLuminance,
      isDarkScene: analysis.isDarkScene,
      isWarmScene: analysis.isWarmScene
    }
  };
}
