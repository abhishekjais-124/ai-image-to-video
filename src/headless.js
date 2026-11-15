// Headless entry point: the same engine as the studio UI, driven by scripts
// (scripts/render.js, scripts/inspect.js, tests/e2e) through window.studio.

import { buildScenePlan } from './models/inhouse-models.js';
import { produceClip } from './engine/pipeline.js';
import { inspectVideo } from './engine/quality-inspector.js';
import { decodeH264Mp4 } from './engine/mp4-muxer.js';
import { saveVideoToOutputs, saveReportToOutputs, clearSegmentCache, segmentCacheSize } from './engine/exporter.js';
import { prepareScene, renderFrameAtTime } from './engine/renderer.js';
import { getResolutionDims } from './presets/fact-presets.js';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${src}`));
    img.src = src;
  });
}

function compileCustomCode(source) {
  const code = String(source || '');
  if (!code.replace(/\/\/.*$/gm, '').trim()) return null;
  return new Function('ctx', 'params', code);
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function bytesFrom({ url, base64 }) {
  if (base64) return base64ToBytes(base64);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function sceneOptionsFromPlan(plan, img, characterImg) {
  return {
    img,
    duration: Number(plan.duration) || 4,
    aspectRatio: plan.aspectRatio === '16:9' ? '16:9' : '9:16',
    resolution: plan.resolution === '1440p' ? '1440p' : '1080p',
    presetId: plan.presetId || 'documentary-kenburns',
    factTitle: plan.factTitle ?? '',
    factSubtitle: plan.factSubtitle ?? '',
    scenePlan: plan,
    customDrawFn: compileCustomCode(plan.customCodeSource || plan.generatedCustomCode),
    characterImg
  };
}

window.studio = {
  /** Build a scene plan from the real image pixels (saliency included). */
  async buildPlan({ imageSrc, ...options }) {
    const img = await loadImage(imageSrc);
    const plan = buildScenePlan({ img, ...options });
    plan.imageSrc = imageSrc;
    return plan;
  },

  /** Render a scene plan through the full pipeline; saves the MP4 and its quality report. */
  async render({ plan, quality = 'fast', autoRepair = true, maxRepairAttempts = 2, inspect = true, saveAs = null, overwrite = false, characterSrc = null, useCache = true }) {
    const img = await loadImage(plan.imageSrc);
    const characterImg = characterSrc ? await loadImage(characterSrc) : null;
    const stages = [];
    const out = await produceClip({
      ...sceneOptionsFromPlan(plan, img, characterImg),
      quality,
      autoRepair,
      maxRepairAttempts,
      inspect,
      useCache,
      fileName: saveAs,
      onStage: (s) => stages.push(s)
    });

    let saved = null;
    let savedReport = null;
    if (saveAs) {
      const name = `${saveAs}.${out.result.ext}`;
      saved = await saveVideoToOutputs(out.result.bytes, name, { overwrite });
      out.report.file = saved?.fileName || name;
      savedReport = await saveReportToOutputs(out.report, out.report.file);
    }
    return {
      saved,
      savedReport,
      report: out.report,
      attempts: out.attempts,
      scenePlan: out.scenePlan,
      verification: out.result.verification,
      segments: out.result.segments,
      timings: out.result.timings,
      path: out.result.path,
      failures: out.result.failures,
      stages
    };
  },

  /** Inspect any MP4 (no scene plan needed): container, full decode, brightness/motion heuristics. */
  async inspect({ url = null, base64 = null, fileName = null }) {
    return inspectVideo({ bytes: await bytesFrom({ url, base64 }), fileName });
  },

  /** Decode a file and return selected frames as JPEG data URLs (for before/after contact sheets). */
  async frames({ url = null, base64 = null, indices = [0], width = 540 }) {
    const bytes = await bytesFrom({ url, base64 });
    const wanted = new Set(indices);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const frames = {};
    const decoded = await decodeH264Mp4(bytes, {
      onFrame: (frame, index) => {
        if (!wanted.has(index)) return;
        canvas.width = width;
        canvas.height = Math.round((width * frame.displayHeight) / frame.displayWidth);
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frames[index] = canvas.toDataURL('image/jpeg', 0.86);
      }
    });
    return { frames, decodedFrames: decoded.decodedFrames, errors: decoded.errors };
  },

  /** Render single frames of a plan straight from the renderer (no encode) — used by tests. */
  async stills({ plan, times = [0], width = 540, layers = {} }) {
    const img = await loadImage(plan.imageSrc);
    const options = sceneOptionsFromPlan(plan, img, null);
    const runtime = prepareScene(options);
    const dims = getResolutionDims(options.aspectRatio, options.resolution);
    const full = document.createElement('canvas');
    full.width = dims.width;
    full.height = dims.height;
    const fullCtx = full.getContext('2d');
    const small = document.createElement('canvas');
    small.width = width;
    small.height = Math.round((width * dims.height) / dims.width);
    const smallCtx = small.getContext('2d');
    const out = {};
    for (const t of times) {
      renderFrameAtTime(fullCtx, { ...options, t, runtime, layers });
      smallCtx.drawImage(full, 0, 0, small.width, small.height);
      out[t] = small.toDataURL('image/jpeg', 0.86);
    }
    return { stills: out, probe: runtime.probe, backdrop: runtime.backdrop, character: runtime.character };
  },

  clearCache: () => clearSegmentCache(),
  cacheSize: () => segmentCacheSize(),
  ready: true
};
