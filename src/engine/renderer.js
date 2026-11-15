// Core 1080p+ / 30 FPS Frame-Accurate Renderer Engine
// Plain ES Module — shared by live preview AND frame-by-frame video export.

import {
  FIXED_FPS,
  FACT_PRESETS,
  getResolutionDims,
  computeCameraTransform,
  renderPresetEffects,
  renderFilmGrade,
  resolveEffectIntensity,
  seededRandom
} from '../presets/fact-presets.js';
import { renderCharacter, renderCharacterCutout, planCharacterPlacement, characterBodyBox } from './character.js';
import {
  DEFAULT_OVERSCAN,
  computeCoverGeometry,
  solveShotFramings,
  evaluateTimelineCamera,
  projectImageBox,
  projectImagePoint,
  boxVisibility
} from './camera.js';
import { planTimeline } from './director.js';
import { layoutCaptions, drawCaptions, createCanvasMeasurer, approximateMeasurer } from './captions.js';
import { analyzeImagePixels, DEFAULT_ANALYSIS } from '../models/inhouse-models.js';
import {
  DEFAULT_EXPOSURE_LIMITS,
  computeFrameStats,
  measureEffectExcess,
  relativeLuminance,
  contrastRatio
} from './frame-metrics.js';

/**
 * Check whether the uploaded image meets the target 1080p+ output dimensions.
 * Note: SVG images are vector-based and scale losslessly to any resolution.
 */
export function checkImageResolution(img, aspectRatio = '9:16', resolution = '1080p', imageSrc = '') {
  const { width: targetW, height: targetH } = getResolutionDims(aspectRatio, resolution);
  const isSvg =
    typeof imageSrc === 'string' &&
    (imageSrc.endsWith('.svg') || imageSrc.startsWith('data:image/svg+xml'));

  const srcW = Number(img?.naturalWidth || img?.width || 0);
  const srcH = Number(img?.naturalHeight || img?.height || 0);

  if (isSvg) {
    return {
      isVector: true,
      meetsMinResolution: true,
      srcW: targetW,
      srcH: targetH,
      targetW,
      targetH,
      message: `Vector SVG source — scales losslessly to ${targetW}×${targetH} (${resolution}).`
    };
  }

  // Check if shortest/longest sides or total pixels are below 1080p target
  const meetsMinResolution = srcW >= targetW && srcH >= targetH;
  return {
    isVector: false,
    meetsMinResolution,
    srcW,
    srcH,
    targetW,
    targetH,
    message: meetsMinResolution
      ? `Source (${srcW}×${srcH}) meets ${targetW}×${targetH} (${resolution}) target.`
      : `Low-res source (${srcW}×${srcH}) will be upscaled to ${targetW}×${targetH} (${resolution}) and may look softer.`
  };
}

/**
 * Draw `img` into `(0, 0, canvasW, canvasH)` using CSS `object-fit: cover` math
 * with focal point `(focusX, focusY)` in `[0..1]` and an overscan factor so camera
 * pans/rotations never expose black borders.
 */
export function drawImageCover(ctx, img, canvasW, canvasH, focusX = 0.5, focusY = 0.5, overscan = DEFAULT_OVERSCAN) {
  const imgW = Number(img?.naturalWidth || img?.width || canvasW);
  const imgH = Number(img?.naturalHeight || img?.height || canvasH);
  if (!imgW || !imgH) return;

  const targetW = canvasW * overscan;
  const targetH = canvasH * overscan;

  const scale = Math.max(targetW / imgW, targetH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;

  // Position image so (focusX, focusY) stays centered when cropping excess aspect ratio
  const clampedFX = Math.max(0, Math.min(1, focusX));
  const clampedFY = Math.max(0, Math.min(1, focusY));

  const extraW = Math.max(0, drawW - canvasW);
  const extraH = Math.max(0, drawH - canvasH);

  const destX = -extraW * clampedFX;
  const destY = -extraH * clampedFY;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, destX, destY, drawW, drawH);
}

/**
 * Word-wrap a string to fit within `maxWidth` pixels on `ctx`.
 */
export function wrapTextLines(ctx, text, maxWidth) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const paragraphs = raw.split(/\r?\n/);
  const lines = [];

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    let currentLine = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${currentLine} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        currentLine = candidate;
      } else {
        lines.push(currentLine);
        currentLine = words[i];
      }
    }
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Render the cinematic edge vignette (darkens corners only; the centre is untouched).
 */
function renderVignette(ctx, width, height, strength = 0.6) {
  const clamped = Math.max(0, Math.min(1, Number(strength ?? 0.6)));
  if (clamped <= 0.01) return;

  ctx.save();
  const radius = Math.max(width, height) * 0.72;
  const grad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.46,
    Math.min(width, height) * 0.34,
    width * 0.5,
    height * 0.5,
    radius
  );
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(0.62, `rgba(0, 0, 0, ${(clamped * 0.2).toFixed(3)})`);
  grad.addColorStop(1, `rgba(0, 0, 0, ${(clamped * 0.62).toFixed(3)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/* ============================================================================
   Scene runtime
   Everything that is decided once per clip — saliency, the shot timeline with
   bounds-safe framings, caption layout, presenter placement, and the measured
   limits for the effects layer — lives in a "runtime" object. Each frame is
   then a pure function of (runtime, t), so preview === export.
   ============================================================================ */

const runtimeCache = new WeakMap(); // scenePlan object → Map(signature → runtime)
const objectIds = new WeakMap();
let nextObjectId = 1;

function idOf(obj) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return 0;
  if (!objectIds.has(obj)) objectIds.set(obj, nextObjectId++);
  return objectIds.get(obj);
}

function createCanvas(width, height, readback = false) {
  let canvas = null;
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } else if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  }
  if (!canvas) return null;
  const ctx = canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined);
  return ctx ? { canvas, ctx } : null;
}

function isVectorImage(img) {
  const src = String(img?.currentSrc || img?.src || '');
  return src.endsWith('.svg') || src.startsWith('data:image/svg+xml');
}

function clipBox(box) {
  return {
    x0: Math.max(0, Math.min(1, box.x0)),
    y0: Math.max(0, Math.min(1, box.y0)),
    x1: Math.max(0, Math.min(1, box.x1)),
    y1: Math.max(0, Math.min(1, box.y1))
  };
}

/** Drop a leaked canvas state (a custom snippet that threw mid-draw must not poison later layers). */
function resetContextState(ctx) {
  if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  if ('filter' in ctx) ctx.filter = 'none';
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
}

/**
 * Prepare a clip for rendering. Decides, once:
 *   • saliency  — subject box / focal point / close-up targets of the real image
 *   • timeline  — caption cues + shots (re-planned if the text or duration changed)
 *   • framings  — every shot solved against image bounds and the caption-free safe area
 *   • captions  — fitted, safe-zone-checked layout
 *   • presenter — standing spot and size that do not cover the subject
 *   • effects   — per-shot opacity measured against exposure limits (probe frames)
 *
 * `probe: false` skips the pixel probes (used in Node and for cheap planning).
 */
export function prepareScene({
  img = null,
  duration = 4,
  aspectRatio = '9:16',
  resolution = '1080p',
  presetId = 'documentary-kenburns',
  factTitle,
  factSubtitle,
  scenePlan = {},
  customDrawFn = null,
  characterImg = null,
  probe = true
} = {}) {
  const dims = getResolutionDims(aspectRatio, resolution);
  const { width, height } = dims;
  const plan = scenePlan || {};
  const preset = FACT_PRESETS.find((p) => p.id === presetId) || FACT_PRESETS[0];
  const mode = plan.cameraMode === 'director' ? 'director' : 'manual';
  const title = String(factTitle ?? plan.factTitle ?? '').trim();
  const subtitle = String(factSubtitle ?? plan.factSubtitle ?? '').replace(/\s+/g, ' ').trim();

  const imgW = Number(img?.naturalWidth || img?.width || 0) || width;
  const imgH = Number(img?.naturalHeight || img?.height || 0) || height;
  const cropFocusX = Number(plan.focusX ?? 0.5);
  const cropFocusY = Number(plan.focusY ?? 0.45);
  const geom = computeCoverGeometry({ imgW, imgH, canvasW: width, canvasH: height, focusX: cropFocusX, focusY: cropFocusY });

  // --- Saliency: stored in the plan when it came from real pixels, else measured now.
  let saliency;
  if (plan.saliency?.subjectBox) {
    saliency = {
      ...DEFAULT_ANALYSIS,
      focusX: cropFocusX,
      focusY: cropFocusY,
      ...plan.saliency,
      analysed: true
    };
  } else if (img) {
    saliency = analyzeImagePixels(img);
  } else {
    saliency = { ...DEFAULT_ANALYSIS };
  }

  // --- Timeline: reuse the plan's when it was planned from this exact text + duration.
  const stored = plan.timeline;
  const timelineIsCurrent =
    stored && Array.isArray(stored.shots) && stored.source && stored.source.text === subtitle && stored.source.duration === duration;
  const timeline = timelineIsCurrent
    ? stored
    : planTimeline({
        narration: subtitle,
        duration,
        modelId: plan.modelId || 'saliency-vision',
        seed: Number(plan.variationSeed ?? 1),
        wordTimings: plan.wordTimings || null
      });

  // --- Captions
  const captionMode = plan.captionMode === 'static' ? 'static' : 'phrases';
  const captionStyle = {
    mode: captionMode,
    accentColor: plan.titleColor || '#ffd166',
    ...(plan.captionStyle || {})
  };
  const cues =
    captionMode === 'static'
      ? subtitle
        ? [{
            id: 'cue-1',
            start: 0,
            end: duration,
            text: subtitle,
            words: subtitle.split(' ').map((text) => ({ text, start: 0, end: duration, emphasis: false }))
          }]
        : []
      : timeline.cues;

  const measureCanvas = createCanvas(8, 8);
  const measure = measureCanvas ? createCanvasMeasurer(measureCanvas.ctx) : approximateMeasurer;
  const captionLayout = layoutCaptions({ measure, width, height, aspectRatio, title, cues, style: captionStyle });
  const hasCaptions = Boolean(captionLayout.title || captionLayout.cues.length);

  // The subject is framed inside this area: clear of the caption block and the frame edges.
  const safeArea = {
    x0: 0.06,
    y0: 0.07,
    x1: 0.94,
    y1: hasCaptions ? Math.max(0.4, captionLayout.band.y0 - 0.025) : 0.9
  };

  // --- Shots
  const overrides = plan.shotOverrides || {};
  let shots;
  if (mode === 'director') {
    const merged = timeline.shots.map((s) => ({ ...s, ...(overrides[s.id] || {}) }));
    shots = solveShotFramings(merged, {
      geom,
      saliency,
      safeArea,
      isVector: isVectorImage(img),
      seed: Number(plan.variationSeed ?? 1),
      rotateDeg: presetId === '3d-perspective-tilt' ? Number(preset.defaults.rotateDeg || 0) * 0.5 : 0,
      motionScale: Number(plan.motionScale ?? 1)
    });
  } else {
    shots = [{ id: 'shot-1', start: 0, end: duration, type: 'manual', intent: 'single', transitionIn: { type: 'cut', duration: 0 }, ...(overrides['shot-1'] || {}) }];
  }

  const globalHandheld = Number(plan.handheld ?? timeline.style?.handheld ?? preset.defaults.handheld ?? 0);
  const beatPunch = Number(plan.beatPunch ?? timeline.style?.beatPunch ?? 0);
  const beats = timeline.beats || [];

  const cameraAt = (t) => {
    if (mode === 'director') {
      return evaluateTimelineCamera(shots, t, geom, {
        handheld: (shot) => Number(shot.handheld ?? globalHandheld),
        beats,
        beatPunch
      });
    }
    // Manual plans honour the same per-shot repair overrides (wider framing, no sway).
    const o = overrides['shot-1'] || {};
    const zoomScale = Number(o.zoomScale ?? 1);
    const manualPlan = {
      ...plan,
      ...o,
      zoomStart: Number(plan.zoomStart ?? 1.03) * zoomScale,
      zoomEnd: Number(plan.zoomEnd ?? 1.18) * zoomScale
    };
    const cam = computeCameraTransform(t, duration, presetId, manualPlan, geom);
    return { cam, shotIndex: 0, shot: shots[0], local: cam.progress, blend: null };
  };

  const subjectBoxAt = (t) => clipBox(projectImageBox(saliency.subjectBox, cameraAt(t).cam, geom));
  const focusAt = (t) => {
    const p = projectImagePoint(saliency.focusX, saliency.focusY, cameraAt(t).cam, geom);
    return { x: p.x / width, y: p.y / height };
  };

  // Per-shot subject visibility for manual plans too (the director already recorded it while solving).
  if (mode === 'manual') {
    const vis = (t) => Number(boxVisibility(saliency.subjectBox, cameraAt(t).cam, geom, safeArea).toFixed(3));
    shots[0].subjectVisibility = { start: vis(0), end: vis(duration - 1 / FIXED_FPS) };
    shots[0].targetVisibility = shots[0].subjectVisibility;
  }

  // --- Presenter placement (beside the subject, above the captions)
  let character = null;
  if (plan.characterEnabled !== false) {
    const sampleBoxes = [];
    for (let t = duration * 0.34; t < duration; t += 0.25) sampleBoxes.push(subjectBoxAt(t));
    const auto = planCharacterPlacement({
      subjectBoxes: sampleBoxes,
      width,
      height,
      captionTop: hasCaptions ? captionLayout.band.y0 : 0.78,
      maxOcclusion: Number(plan.maxCharacterOcclusion ?? 0.1)
    });
    character = { ...auto, ...(plan.characterPlacement || {}) };
    character.bodyBox = characterBodyBox({ ...character, width, height });
  }

  const runtime = {
    version: 2,
    dims,
    aspectRatio,
    resolution,
    duration,
    presetId,
    preset,
    mode,
    plan,
    geom,
    cropFocusX,
    cropFocusY,
    saliency,
    timeline,
    shots,
    beats,
    title,
    subtitle,
    captionMode,
    captionStyle,
    captionLayout,
    hasCaptions,
    safeArea,
    character,
    effectIntensity: resolveEffectIntensity(plan),
    exposureLimits: { ...DEFAULT_EXPOSURE_LIMITS, ...(plan.exposureLimits || {}) },
    // Filled in by the probes below (neutral when probing is not possible).
    fxGains: shots.map((s) => Math.max(0, Math.min(1, Number(s.fxGain ?? 1)))),
    backdrop: captionStyle.backdrop && captionStyle.backdrop !== 'auto' ? captionStyle.backdrop : captionMode === 'static' ? 'card' : 'scrim',
    probe: null,
    customCodeError: null,
    cameraAt,
    subjectBoxAt,
    focusAt
  };

  if (probe && img) {
    try {
      runSceneProbes(runtime, { img, customDrawFn, characterImg });
    } catch (err) {
      // Probing is an optimisation of quality, never a reason to fail a render.
      runtime.probe = { error: String(err?.message || err) };
    }
  }

  return runtime;
}

/** Cached runtime for the live preview: rebuilt only when something that affects it changes. */
function getSceneRuntime(opts) {
  const plan = opts.scenePlan || {};
  const img = opts.img;
  const signature = [
    idOf(img), img?.naturalWidth || img?.width || 0, img?.naturalHeight || img?.height || 0,
    opts.duration, opts.aspectRatio, opts.resolution, opts.presetId,
    opts.factTitle ?? '', opts.factSubtitle ?? '', idOf(opts.customDrawFn), idOf(opts.characterImg)
  ].join('|');

  let perPlan = runtimeCache.get(plan);
  if (!perPlan) {
    perPlan = new Map();
    runtimeCache.set(plan, perPlan);
  }
  let runtime = perPlan.get(signature);
  if (!runtime) {
    if (perPlan.size > 6) perPlan.clear();
    runtime = prepareScene(opts);
    perPlan.set(signature, runtime);
  }
  return runtime;
}

/** Forget cached runtimes for a plan object that was mutated in place. */
export function invalidateSceneRuntime(scenePlan) {
  if (scenePlan) runtimeCache.delete(scenePlan);
}

/* ============================================================================
   Layered frame drawing
   ============================================================================ */

const layerCache = new WeakMap(); // target canvas → { canvas, ctx } effects layer

function getEffectsLayer(ctx, width, height) {
  const key = ctx.canvas;
  if (!key) return null;
  let layer = layerCache.get(key);
  if (!layer) {
    layer = createCanvas(width, height);
    if (!layer) return null;
    layerCache.set(key, layer);
  }
  if (layer.canvas.width !== width) layer.canvas.width = width;
  if (layer.canvas.height !== height) layer.canvas.height = height;
  return layer;
}

function drawBaseImage(ctx, img, cam, width, height, runtime) {
  if (!img) return;
  ctx.save();
  ctx.translate(width * 0.5 + cam.offsetX * width, height * 0.5 + cam.offsetY * height);
  ctx.rotate(cam.rotationRad);
  ctx.scale(cam.scale, cam.scale);
  ctx.translate(-width * 0.5, -height * 0.5);
  drawImageCover(ctx, img, width, height, runtime.cropFocusX, runtime.cropFocusY, DEFAULT_OVERSCAN);
  ctx.restore();
}

function bump(t, centre, half) {
  const d = Math.abs(t - centre) / half;
  return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(d * Math.PI);
}

/**
 * Draw one frame of the scene. `layers` switches individual layers off (used
 * by the probes and the quality inspector to render "clean plates").
 */
function drawScene(ctx, { img, customDrawFn = null, characterImg = null }, runtime, {
  t,
  width,
  height,
  layers = {},
  fxGain = null
}) {
  const { plan, duration, presetId } = runtime;
  const show = { fx: true, character: true, vignette: true, captions: true, ...layers };
  const state = runtime.cameraAt(t);
  const cam = state.cam;

  ctx.save();
  resetContextState(ctx);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  // 1. Base image through the camera. During a dissolve the outgoing shot is drawn underneath.
  if (state.blend) {
    drawBaseImage(ctx, img, state.blend.cam, width, height, runtime);
    ctx.globalAlpha = state.blend.alpha;
    drawBaseImage(ctx, img, cam, width, height, runtime);
    ctx.globalAlpha = 1;
  } else {
    drawBaseImage(ctx, img, cam, width, height, runtime);
  }

  // 2. Film grade (warm/cool tint from the preset)
  renderFilmGrade(ctx, {
    width,
    height,
    warmth: plan.warmth ?? runtime.preset.defaults.warmth ?? 0,
    intensity: runtime.effectIntensity
  });

  const subject = clipBox(projectImageBox(runtime.saliency.subjectBox, cam, runtime.geom));
  const focusPoint = projectImagePoint(runtime.saliency.focusX, runtime.saliency.focusY, cam, runtime.geom);
  const focusX = Math.max(0, Math.min(1, focusPoint.x / runtime.dims.width));
  const focusY = Math.max(0, Math.min(1, focusPoint.y / runtime.dims.height));

  // 3. Effects layer: atmosphere, light and the custom snippet are drawn on their own
  //    transparent layer with normal alpha blending, then composited at a measured
  //    opacity. Nothing here is additive, so brightness cannot pile up frame over frame.
  if (show.fx && runtime.effectIntensity > 0.001) {
    let gain = fxGain;
    if (gain === null) {
      gain = runtime.fxGains[state.shotIndex] ?? 1;
      if (state.blend && state.shotIndex > 0) {
        const prev = runtime.fxGains[state.shotIndex - 1] ?? 1;
        gain = prev + (gain - prev) * state.blend.alpha;
      }
    }

    if (gain > 0.004) {
      const layer = getEffectsLayer(ctx, width, height);
      const fxCtx = layer ? layer.ctx : ctx;
      if (layer) {
        resetContextState(fxCtx);
        fxCtx.clearRect(0, 0, width, height);
      } else {
        ctx.save();
        ctx.globalAlpha = gain;
      }

      fxCtx.save();
      renderPresetEffects(fxCtx, {
        presetId,
        t,
        duration,
        width,
        height,
        scenePlan: plan,
        intensity: runtime.effectIntensity,
        cam,
        subject,
        beats: runtime.beats,
        drawCoverImage: (target = fxCtx) => drawBaseImage(target, img, cam, width, height, runtime)
      });
      fxCtx.restore();

      // A restrained glow on the subject as the key word lands (reveal/emphasis), never a full-frame flash.
      if (plan.beatGlow !== false && runtime.beats.length && (runtime.timeline.style?.energy ?? 0) >= 0.5) {
        let glow = 0;
        for (const b of runtime.beats) glow = Math.max(glow, (b.strength ?? 1) * bump(t, b.t + 0.18, 0.5));
        if (glow > 0.01) {
          const cx = focusX * width;
          const cy = focusY * height;
          const r = Math.min(width, height) * 0.42;
          const grad = fxCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
          const accent = plan.accentColor || '255, 225, 155';
          grad.addColorStop(0, `rgba(${accent}, ${(0.12 * glow * runtime.effectIntensity).toFixed(3)})`);
          grad.addColorStop(1, `rgba(${accent}, 0)`);
          fxCtx.fillStyle = grad;
          fxCtx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
      }

      // Custom scene code (Live Code Editor / agent-generated). It draws into the
      // effects layer, so the exposure limits apply to it as well.
      if (typeof customDrawFn === 'function') {
        fxCtx.save();
        try {
          customDrawFn(fxCtx, {
            t,
            frame: Math.floor(t * FIXED_FPS),
            fps: FIXED_FPS,
            duration,
            progress: Math.max(0, Math.min(1, t / Math.max(0.1, duration))),
            width,
            height,
            focusX,
            focusY,
            subject,
            intensity: runtime.effectIntensity,
            seededRandom
          });
        } catch (err) {
          // A broken snippet must not crash the render loop — but it is recorded, not hidden.
          if (!runtime.customCodeError) runtime.customCodeError = String(err?.message || err);
        } finally {
          fxCtx.restore();
          if (layer) resetContextState(fxCtx);
        }
      }

      if (layer) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, gain);
        ctx.drawImage(layer.canvas, 0, 0, width, height);
        ctx.restore();
      } else {
        ctx.restore();
      }
    }
  }

  // 4. Presenter — drawn in front of the image (a flat image cannot move its own limbs),
  //    placed beside the subject and above the captions.
  if (show.character && runtime.character) {
    const characterOpts = {
      t,
      duration,
      width,
      height,
      action: plan.characterAction || 'walk-point',
      seed: Number(plan.variationSeed ?? 1),
      focusX,
      focusY,
      standX: runtime.character.standX,
      heightFrac: runtime.character.heightFrac,
      feetYFrac: runtime.character.feetYFrac
    };
    if (characterImg) renderCharacterCutout(ctx, { ...characterOpts, img: characterImg });
    else renderCharacter(ctx, characterOpts);
  }

  // 5. Edge vignette
  if (show.vignette) {
    renderVignette(ctx, width, height, plan.vignetteStrength ?? runtime.preset.defaults.vignetteStrength ?? 0.6);
  }

  // 6. Captions (laid out for the runtime's resolution)
  if (show.captions && runtime.hasCaptions && width === runtime.dims.width) {
    drawCaptions(ctx, runtime.captionLayout, {
      t,
      style: runtime.captionStyle,
      timingSource: runtime.timeline.timingSource,
      backdrop: runtime.backdrop
    });
  }

  ctx.restore();
  return state;
}

/* ============================================================================
   Probes — low-resolution test renders used to keep effects inside exposure
   limits and to pick a caption backdrop from the real background.
   ============================================================================ */

function probeSize(runtime) {
  const width = Math.max(96, Math.round(runtime.dims.width / 8));
  return { width, height: Math.round((width * runtime.dims.height) / runtime.dims.width) };
}

function probeTimes(shot) {
  const span = shot.end - shot.start;
  const n = Math.max(2, Math.min(6, Math.ceil(span / 0.4)));
  const times = [];
  for (let k = 0; k < n; k++) times.push(shot.start + ((k + 0.5) / n) * span);
  return times;
}

/**
 * Render a low-resolution frame and return its RGBA pixels (browser only).
 * Used by the probes here and by the quality inspector for clean-plate comparisons.
 */
export function renderProbeFrame(runtime, sources, t, { layers = {}, fxGain = null, target = null, size: requestedSize = null } = {}) {
  const size = requestedSize || probeSize(runtime);
  const surface = target || createCanvas(size.width, size.height, true);
  if (!surface) return null;
  drawScene(surface.ctx, sources, runtime, { t, width: size.width, height: size.height, layers, fxGain });
  return {
    width: size.width,
    height: size.height,
    data: surface.ctx.getImageData(0, 0, size.width, size.height).data,
    surface
  };
}

function runSceneProbes(runtime, sources) {
  const size = probeSize(runtime);
  const plateSurface = createCanvas(size.width, size.height, true);
  const fullSurface = createCanvas(size.width, size.height, true);
  if (!plateSurface || !fullSurface) return;

  const limits = runtime.exposureLimits;
  const noOverlays = { character: false, captions: false };
  const shotReports = [];

  runtime.shots.forEach((shot, index) => {
    const requested = runtime.fxGains[index];
    let shotGain = requested;
    let worst = null;

    for (const t of probeTimes(shot)) {
      const subjectBox = runtime.subjectBoxAt(t);
      const visibleSubject = { ...subjectBox, y1: Math.min(subjectBox.y1, runtime.safeArea.y1) };
      const plate = renderProbeFrame(runtime, sources, t, { layers: { ...noOverlays, fx: false }, target: plateSurface });
      const plateStats = computeFrameStats(plate.data, plate.width, plate.height);
      const plateSubject = computeFrameStats(plate.data, plate.width, plate.height, { box: visibleSubject });

      let gain = shotGain;
      let excess = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const full = renderProbeFrame(runtime, sources, t, { layers: noOverlays, fxGain: gain, target: fullSurface });
        excess = measureEffectExcess(
          plateStats,
          computeFrameStats(full.data, full.width, full.height),
          plateSubject,
          computeFrameStats(full.data, full.width, full.height, { box: visibleSubject }),
          limits
        );
        if (excess.ratio <= 1.02 || gain <= 0.05) break;
        gain = Math.max(0.05, (gain / excess.ratio) * 0.96);
      }
      shotGain = Math.min(shotGain, gain);
      if (!worst || excess.ratio > worst.ratio) worst = { t: Number(t.toFixed(3)), ...excess };
    }

    runtime.fxGains[index] = Number(shotGain.toFixed(3));
    shotReports.push({
      shotId: shot.id,
      requestedGain: requested,
      appliedGain: runtime.fxGains[index],
      attenuated: shotGain < requested - 0.02,
      worst: worst
        ? {
            t: worst.t,
            ratio: Number(worst.ratio.toFixed(3)),
            lumaDelta: Number(worst.lumaDelta.toFixed(2)),
            clipGain: Number(worst.clipGain.toFixed(4)),
            subjectShift: Number(worst.subjectShift.toFixed(2)),
            contrastKept: Number(worst.contrastKept.toFixed(3))
          }
        : null
    });
  });

  // Caption backdrop: measure what is actually behind the text (image + effects) and
  // escalate none → scrim → card until white text clears a 4.5:1 contrast ratio.
  let captionProbe = null;
  if (runtime.hasCaptions) {
    const band = clipBox(runtime.captionLayout.band);
    let bgP90 = 0;
    let bgStd = 0;
    const times = runtime.captionLayout.cues.length
      ? runtime.captionLayout.cues.map((c) => Math.min(runtime.duration - 1 / FIXED_FPS, (c.start + c.end) / 2))
      : [runtime.duration / 2];
    for (const t of times) {
      const frame = renderProbeFrame(runtime, sources, t, { layers: noOverlays, target: fullSurface });
      const stats = computeFrameStats(frame.data, frame.width, frame.height, { box: band });
      bgP90 = Math.max(bgP90, stats.lumaP90);
      bgStd = Math.max(bgStd, stats.stdLuma);
    }
    const contrastWith = (dim) => contrastRatio(1, relativeLuminance(bgP90 * (1 - dim)));
    const options = [
      { backdrop: 'none', dim: 0 },
      { backdrop: 'scrim', dim: 0.46 },
      { backdrop: 'card', dim: 0.6 }
    ];
    const auto = !runtime.captionStyle.backdrop || runtime.captionStyle.backdrop === 'auto';
    let chosen = options.find((o) => o.backdrop === runtime.backdrop) || options[1];
    if (auto) {
      if (runtime.captionMode === 'static') chosen = options[2];
      else chosen = options.find((o) => contrastWith(o.dim) >= 4.5 && (o.backdrop !== 'none' || bgStd < 34)) || options[2];
      runtime.backdrop = chosen.backdrop;
    }
    captionProbe = {
      backgroundLumaP90: bgP90,
      backgroundStd: Number(bgStd.toFixed(1)),
      backdrop: runtime.backdrop,
      contrastRatio: Number(contrastWith(chosen.dim).toFixed(2)),
      chosenAutomatically: auto
    };
  }

  runtime.probe = { size, shots: shotReports, captions: captionProbe };
}

/**
 * Render a single deterministic frame at timestamp `t` (in seconds) onto `ctx`.
 * At 30 FPS, frame index `n` corresponds to `t = n / 30`.
 *
 * Pass a `runtime` from prepareScene() to control exactly what is rendered
 * (the exporter does); without one a cached runtime is prepared on demand.
 */
export function renderFrameAtTime(ctx, {
  img,
  t = 0,
  duration = 4,
  aspectRatio = '9:16',
  resolution = '1080p',
  presetId = 'documentary-kenburns',
  factTitle = '',
  factSubtitle = '',
  scenePlan = {},
  customDrawFn = null,
  characterImg = null,
  runtime = null,
  layers = {}
}) {
  const rt =
    runtime ||
    getSceneRuntime({ img, duration, aspectRatio, resolution, presetId, factTitle, factSubtitle, scenePlan, customDrawFn, characterImg });
  const { width, height } = rt.dims;

  // Ensure canvas pixel buffer matches exact target resolution
  if (ctx.canvas.width !== width) ctx.canvas.width = width;
  if (ctx.canvas.height !== height) ctx.canvas.height = height;

  const clampedT = Math.max(0, Math.min(rt.duration, t));
  const state = drawScene(ctx, { img, customDrawFn, characterImg }, rt, { t: clampedT, width, height, layers });

  return {
    frame: Math.floor(t * FIXED_FPS),
    totalFrames: Math.round(rt.duration * FIXED_FPS),
    fps: FIXED_FPS,
    width,
    height,
    shotIndex: state.shotIndex,
    shotId: state.shot?.id
  };
}
