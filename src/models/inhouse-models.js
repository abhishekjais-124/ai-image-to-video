// 100% In-House, Zero-API-Key Visual Analysis & Scene Direction Models
// Compatible with Browser, Antigravity, Claude Desktop, and Codex workflows.

import { FACT_PRESETS } from '../presets/fact-presets.js';

export const INHOUSE_MODELS = [
  {
    id: 'saliency-vision',
    name: 'In-House Saliency Vision v1 (Auto Focus & Palette)',
    description:
      'Analyzes image pixel contrast, luminance, and color temperature to locate the subject focal point and match lighting.'
  },
  {
    id: 'viral-hook-v1',
    name: 'Viral Shorts Hook Director (Fast Push + High Drama)',
    description:
      'High-retention camera push toward the upper-center subject with dramatic spotlighting and punchy vignette.'
  },
  {
    id: 'cinematic-doc-v1',
    name: 'Cinematic Documentary Master (Slow Pull-Out + Warmth)',
    description:
      'Steady tripod-style pull-back reveal with warm atmospheric particles and gentle perspective drift.'
  },
  {
    id: 'mystery-noir-v1',
    name: 'Mystery & True-Crime Director (Handheld + Cold Mist)',
    description:
      'Moody handheld camera motion paired with rolling fog banks and deep shadow pulses.'
  }
];

/**
 * Inspect actual image pixels on a 96x96 offscreen canvas to find:
 * - High-contrast / salient focal point (focusX, focusY)
 * - Average luminance & color warmth
 * - Dominant highlight RGB for particles/lighting
 */
export function analyzeImagePixels(img) {
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

        // Local edge gradient (Sobel-like horizontal + vertical contrast)
        const gx = Math.abs(lumAt(x + 1, y) - lumAt(x - 1, y));
        const gy = Math.abs(lumAt(x, y + 1) - lumAt(x, y - 1));
        const edgeStrength = gx + gy;

        // Rule-of-thirds / center-biased saliency weight
        const normX = x / sampleSize;
        const normY = y / sampleSize;
        const centerBias =
          1.0 - 0.65 * Math.hypot(normX - 0.5, normY - 0.42);
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
  } catch (err) {
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
 * Generate a complete, editable Scene Plan based on the selected In-House Model,
 * Preset, and pixel analysis of the uploaded image.
 */
export function buildScenePlan({
  img,
  modelId = 'saliency-vision',
  presetId = 'documentary-kenburns',
  aspectRatio = '9:16',
  resolution = '1080p',
  duration = 4,
  factTitle = '',
  factSubtitle = ''
}) {
  const analysis = img ? analyzeImagePixels(img) : {
    focusX: 0.5,
    focusY: 0.42,
    avgLuminance: 128,
    isDarkScene: false,
    isWarmScene: true,
    accentColor: '255, 225, 155'
  };

  const presetObj = FACT_PRESETS.find((p) => p.id === presetId) || FACT_PRESETS[0];
  const base = { ...presetObj.defaults };

  // Pan camera subtly toward the detected salient focal point
  const panTowardFocusX = Number(((0.5 - analysis.focusX) * 0.14).toFixed(3));
  const panTowardFocusY = Number(((0.45 - analysis.focusY) * 0.14).toFixed(3));

  let zoomStart = base.zoomStart;
  let zoomEnd = base.zoomEnd;
  let panX = panTowardFocusX || base.panX;
  let panY = panTowardFocusY || base.panY;
  let rotateDeg = base.rotateDeg;
  let particleCount = base.particleCount;
  let vignetteStrength = base.vignetteStrength;
  let titleColor = '#ffd166';

  if (modelId === 'viral-hook-v1') {
    zoomStart = 1.04;
    zoomEnd = 1.24;
    rotateDeg = -1.2;
    particleCount = 80;
    vignetteStrength = 0.84;
    titleColor = '#fde047';
  } else if (modelId === 'cinematic-doc-v1') {
    // Slow dramatic pull-back reveal
    zoomStart = 1.18;
    zoomEnd = 1.02;
    panX = -panTowardFocusX;
    panY = -panTowardFocusY;
    rotateDeg = 0.25;
    particleCount = 55;
    vignetteStrength = 0.7;
    titleColor = '#fbbf24';
  } else if (modelId === 'mystery-noir-v1') {
    zoomStart = 1.05;
    zoomEnd = 1.19;
    rotateDeg = 0.75;
    particleCount = 50;
    vignetteStrength = 0.88;
    titleColor = '#38bdf8';
  }

  return {
    schemaVersion: '1.0',
    engine: 'inhouse-30fps-1080p',
    modelId,
    presetId,
    aspectRatio,
    resolution,
    fps: 30,
    duration,
    totalFrames: Math.round(duration * 30),
    focusX: analysis.focusX,
    focusY: analysis.focusY,
    zoomStart,
    zoomEnd,
    panX,
    panY,
    rotateDeg,
    particleCount,
    vignetteStrength,
    accentColor: analysis.accentColor,
    titleColor,
    factTitle,
    factSubtitle,
    analysisSummary: {
      avgLuminance: analysis.avgLuminance,
      isDarkScene: analysis.isDarkScene,
      isWarmScene: analysis.isWarmScene
    }
  };
}
