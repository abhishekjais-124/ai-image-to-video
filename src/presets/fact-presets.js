// Deterministic, time-driven Fact-Short presets (30 FPS constant frame rate, 1080p minimum)
// Plain ES Module — works in Browser, Antigravity, Claude Desktop, and Codex.

import { fitCameraToBounds } from '../engine/camera.js';

export const FIXED_FPS = 30;

export const RESOLUTIONS = {
  '1080p': {
    label: '1080p Full HD (Standard)',
    '9:16': { width: 1080, height: 1920 },
    '16:9': { width: 1920, height: 1080 }
  },
  '1440p': {
    label: '1440p QHD (2K)',
    '9:16': { width: 1440, height: 2560 },
    '16:9': { width: 2560, height: 1440 }
  }
};

export const FACT_PRESETS = [
  {
    id: 'documentary-kenburns',
    name: 'Ken Burns + Dust',
    icon: '📽️',
    description:
      'Smooth camera push toward the focal point with warm floating dust motes and documentary vignette.',
    defaults: {
      zoomStart: 1.00,
      zoomEnd: 1.30,
      panX: -0.06,
      panY: -0.05,
      rotateDeg: 0.8,
      particleCount: 70,
      vignetteStrength: 0.6,
      warmth: 0.12
    }
  },
  {
    id: '3d-perspective-tilt',
    name: '3D Tilt + Spotlight',
    icon: '✨',
    description:
      'Dynamic 3D orbital pan with a sweeping volumetric spotlight and specular light flare over the subject.',
    defaults: {
      zoomStart: 1.03,
      zoomEnd: 1.32,
      panX: 0.06,
      panY: -0.04,
      rotateDeg: -1.6,
      particleCount: 60,
      vignetteStrength: 0.62,
      warmth: 0.08
    }
  },
  {
    id: 'mystery-fog-shake',
    name: 'Fog + Handheld',
    icon: '🌫️',
    description:
      'Layered rolling atmospheric fog, subtle handheld documentary camera sway, and deep shadow pulses.',
    defaults: {
      zoomStart: 1.04,
      zoomEnd: 1.28,
      panX: -0.04,
      panY: 0.04,
      rotateDeg: 0.6,
      particleCount: 65,
      vignetteStrength: 0.7,
      warmth: -0.14,
      handheld: 0.6
    }
  },
  {
    id: 'scifi-cyber-glitch',
    name: 'Cyber Grid + Glitch',
    icon: '⚡',
    description:
      'Holographic HUD grid, sweeping cyan scanline, RGB slice glitch pulses, and digital telemetry frame.',
    defaults: {
      zoomStart: 1.02,
      zoomEnd: 1.28,
      panX: 0.0,
      panY: -0.05,
      rotateDeg: 0.0,
      particleCount: 70,
      vignetteStrength: 0.62,
      warmth: -0.18
    }
  },
  {
    id: 'vintage-film-grain',
    name: 'Film Grain + Light Leaks',
    icon: '🎞️',
    description:
      'Authentic 16mm/35mm film grain, organic amber light leaks, gate weave, and vertical celluloid scratches.',
    defaults: {
      zoomStart: 1.02,
      zoomEnd: 1.26,
      panX: 0.04,
      panY: -0.04,
      rotateDeg: 0.35,
      particleCount: 55,
      vignetteStrength: 0.66,
      warmth: 0.22,
      gateWeave: 0.5
    }
  }
];

export function getResolutionDims(aspectRatio = '9:16', resolution = '1080p') {
  const resTier = RESOLUTIONS[resolution] || RESOLUTIONS['1080p'];
  return resTier[aspectRatio] || resTier['9:16'];
}

// Deterministic pseudo-random generator (mulberry32) so frame n at t = n/30 is 100% repeatable
export function seededRandom(seed) {
  let a = (seed >>> 0) + 0x6d2b79f5;
  return function () {
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth cubic ease-in-out
export function easeInOutCubic(x) {
  const c = Math.max(0, Math.min(1, x));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** Smooth deterministic value noise in [-1, 1] (interpolated, so it never jumps frame to frame). */
export function smoothNoise(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const at = (n) => seededRandom(n * 7919 + seed * 104729)() * 2 - 1;
  const k = f * f * (3 - 2 * f);
  return at(i) + (at(i + 1) - at(i)) * k;
}

/**
 * Classic single-move camera for `cameraMode: 'manual'` scene plans
 * (zoomStart/zoomEnd/panX/panY/rotateDeg) at time `t`.
 *
 * Motion is a pure smooth function of `t`:
 *  - no unconditional shake: sway only when the plan/preset asks for it
 *    (`handheld`, `gateWeave`, `shakeIntensity`), and it is low-frequency
 *    smooth motion, never per-frame random offsets (which read as jitter);
 *  - when `geom` (see camera.computeCoverGeometry) is supplied, the result is
 *    clamped so the view can never leave the image and expose black borders.
 */
export function computeCameraTransform(t, duration, presetId, scenePlan = {}, geom = null) {
  const progress = Math.max(0, Math.min(1, t / Math.max(0.1, duration)));
  // Pure ease-in-out is ~0.008 eased at 12.5% progress — the first second
  // looked frozen. Blend in 30% linear so the camera moves from frame 1.
  const eased = 0.30 * progress + 0.70 * easeInOutCubic(progress);

  const zoomStart = Number(scenePlan.zoomStart ?? 1.03);
  const zoomEnd = Number(scenePlan.zoomEnd ?? 1.18);
  const panX = Number(scenePlan.panX ?? -0.02);
  const panY = Number(scenePlan.panY ?? -0.03);
  const rotateDeg = Number(scenePlan.rotateDeg ?? 0.5);

  let scale = zoomStart + (zoomEnd - zoomStart) * eased;
  let offsetX = panX * eased;
  let offsetY = panY * eased;
  let rotationRad = ((rotateDeg * eased) * Math.PI) / 180;

  const preset = FACT_PRESETS.find((p) => p.id === presetId);
  const handheld = Number(scenePlan.handheld ?? preset?.defaults.handheld ?? 0);
  const gateWeave = Number(scenePlan.gateWeave ?? preset?.defaults.gateWeave ?? 0);

  if (presetId === 'mystery-fog-shake') {
    // Slow handheld sway. `shakeIntensity` keeps its meaning for existing plans.
    const shakeAmp = Number(scenePlan.shakeIntensity ?? 0.004) * handheld;
    offsetX += Math.sin(t * 1.7) * shakeAmp + Math.sin(t * 2.9 + 1.1) * (shakeAmp * 0.35);
    offsetY += Math.cos(t * 1.4) * shakeAmp + Math.sin(t * 2.6 + 0.4) * (shakeAmp * 0.35);
    rotationRad += Math.sin(t * 1.1) * 0.002 * handheld;
  } else if (presetId === 'vintage-film-grain') {
    // Projector gate weave as smooth noise (~5 Hz), a fraction of a pixel wide.
    offsetX += smoothNoise(t * 5, 42) * 0.0006 * gateWeave;
    offsetY += smoothNoise(t * 5, 97) * 0.0006 * gateWeave;
  } else if (presetId === '3d-perspective-tilt') {
    // Smooth orbital arc
    offsetX += Math.sin(progress * Math.PI) * 0.018;
  } else if (handheld > 0) {
    offsetX += (Math.sin(t * 0.9 + 1.2) * 0.0026 + Math.sin(t * 2.1) * 0.0009) * handheld;
    offsetY += (Math.cos(t * 0.7) * 0.0026 + Math.sin(t * 1.7 + 0.6) * 0.0009) * handheld;
  }

  const cam = { scale, offsetX, offsetY, rotationRad };
  if (geom) {
    const fitted = fitCameraToBounds(cam, geom);
    return { ...fitted, progress, eased };
  }
  return { ...cam, progress, eased };
}

/** Clamp the master effect strength to its supported range. */
export function resolveEffectIntensity(scenePlan = {}) {
  const v = Number(scenePlan.effectIntensity ?? 1);
  return Number.isFinite(v) ? Math.max(0, Math.min(1.5, v)) : 1;
}

/**
 * Render preset-specific atmospheric & light effects at exact timestamp `t`.
 *
 * Effects are drawn with normal alpha compositing on a separate layer (see
 * renderer.js) — never additive — so they cannot accumulate into a white-out.
 * Extra context (all optional, so existing callers keep working):
 *   intensity  master strength 0..1.5
 *   cam        current camera → particles/fog move in parallax with the image
 *   subject    subject box in canvas-normalised coords → depth-aware effects
 *              thin out over the subject instead of veiling it
 *   beats      emphasis beats from the timeline (used sparingly)
 */
export function renderPresetEffects(ctx, {
  presetId, t, duration, width, height, scenePlan = {}, drawCoverImage,
  intensity = resolveEffectIntensity(scenePlan), cam = null, subject = null, beats = []
}) {
  if (intensity <= 0.001) return;
  const fx = { t, duration, width, height, scenePlan, intensity, cam, subject, beats, drawCoverImage };
  switch (presetId) {
    case '3d-perspective-tilt':
      render3DSpotlight(ctx, fx);
      break;
    case 'mystery-fog-shake':
      renderMysteryFog(ctx, fx);
      break;
    case 'scifi-cyber-glitch':
      renderSciFiGlitch(ctx, fx);
      break;
    case 'vintage-film-grain':
      renderVintageFilm(ctx, fx);
      break;
    case 'documentary-kenburns':
    default:
      renderDocumentaryDust(ctx, fx);
      break;
  }
}

/** Screen position of an atmosphere element at `depth` (1 = image plane, >1 nearer the lens). */
function parallaxPoint(x, y, depth, fx) {
  if (!fx.cam) return { x, y, k: 1 };
  const cx = fx.width / 2;
  const cy = fx.height / 2;
  const k = 1 + (fx.cam.scale - 1) * depth * 0.8;
  return {
    x: cx + (x - cx) * k + fx.cam.offsetX * fx.width * depth * 0.8,
    y: cy + (y - cy) * k + fx.cam.offsetY * fx.height * depth * 0.8,
    k
  };
}

/** How much of an effect to keep at a point: thinned inside the subject box, with a soft edge. */
function subjectClearance(x, y, fx, keepInside = 0.3) {
  if (!fx.subject) return 1;
  const s = fx.subject;
  const margin = 0.04;
  const dx = Math.max(s.x0 - x / fx.width, x / fx.width - s.x1, 0);
  const dy = Math.max(s.y0 - y / fx.height, y / fx.height - s.y1, 0);
  const outside = Math.min(1, Math.hypot(dx, dy) / margin);
  return keepInside + (1 - keepInside) * outside;
}

/* ============================================================================
   PRESET 1: Documentary Ken Burns + Floating Dust Motes
   ============================================================================ */
function renderDocumentaryDust(ctx, fx) {
  const { t, width, height, scenePlan, intensity } = fx;
  const count = Math.round(Number(scenePlan.particleCount ?? 65) * Math.min(1.2, intensity));
  const rng = seededRandom(101);
  const accentColor = scenePlan.accentColor || '255, 225, 155';
  const unit = width / 1080;

  ctx.save();
  // Soft warm key light from the top-right corner (kept well below wash-out strength).
  const sunGrad = ctx.createRadialGradient(width * 0.84, height * 0.1, width * 0.02, width * 0.84, height * 0.1, width * 0.9);
  sunGrad.addColorStop(0, `rgba(${accentColor}, ${(0.13 * intensity).toFixed(3)})`);
  sunGrad.addColorStop(0.5, `rgba(${accentColor}, ${(0.035 * intensity).toFixed(3)})`);
  sunGrad.addColorStop(1, `rgba(${accentColor}, 0)`);
  ctx.fillStyle = sunGrad;
  ctx.fillRect(0, 0, width, height);

  // Dust motes on three depth layers. Far motes are small, dim and pass "behind"
  // the subject; near motes are larger, softer and drift faster (parallax).
  const spanX = width * 1.3;
  const spanY = height * 1.3;
  for (let i = 0; i < count; i++) {
    const startX = rng() * spanX;
    const startY = rng() * spanY;
    const depth = 0.4 + rng() * 1.6;
    const radius = (1.4 + rng() * 3.0) * unit * (0.55 + depth * 0.5);
    const speedY = (26 + rng() * 44) * depth * unit;
    const speedX = (rng() - 0.5) * 18 * depth * unit;
    const phase = rng() * Math.PI * 2;
    const baseAlpha = 0.22 + rng() * 0.34;

    const wx = ((((startX + speedX * t + Math.sin(t * 1.1 + phase) * 14 * unit) % spanX) + spanX) % spanX) - width * 0.15;
    const wy = ((((startY - speedY * t) % spanY) + spanY) % spanY) - height * 0.15;
    const p = parallaxPoint(wx, wy, depth, fx);
    if (p.x < -40 || p.x > width + 40 || p.y < -40 || p.y > height + 40) continue;

    const twinkle = 0.55 + 0.45 * Math.sin(t * 2.2 + phase);
    const behind = depth < 1 ? subjectClearance(p.x, p.y, fx, 0.25) : 1;
    const alpha = Math.min(0.6, baseAlpha * twinkle * intensity * behind);
    if (alpha < 0.02) continue;
    const r = radius * p.k;

    // Soft halo + small core instead of a shadow-blurred disc: cheaper and it cannot bloom.
    ctx.fillStyle = `rgba(${accentColor}, ${(alpha * 0.22).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${accentColor}, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ============================================================================
   PRESET 2: Spotlight + Volumetric Light Ray
   ============================================================================ */
function render3DSpotlight(ctx, fx) {
  const { t, duration, width, height, scenePlan, intensity } = fx;
  const progress = t / Math.max(0.1, duration);
  // Follow the subject when the renderer knows where it is on screen.
  const focusX = fx.subject ? (fx.subject.x0 + fx.subject.x1) / 2 : Number(scenePlan.focusX ?? 0.5);
  const focusY = fx.subject ? (fx.subject.y0 + fx.subject.y1) / 2 : Number(scenePlan.focusY ?? 0.42);

  // The light drifts gently around the subject instead of sweeping across it.
  const spotX = width * (focusX + Math.sin(progress * Math.PI * 2) * 0.07);
  const spotY = height * (focusY + Math.cos(progress * Math.PI * 2) * 0.04);
  const spotRadius = Math.max(width, height) * 0.58;

  ctx.save();
  // Shape the light in two smooth passes (a single gradient that changes colour
  // mid-way shows up as visible rings on dark images):
  // 1. the surroundings fall off gradually towards the frame edge…
  const falloff = ctx.createRadialGradient(spotX, spotY, spotRadius * 0.4, spotX, spotY, spotRadius * 1.05);
  [[0, 0], [0.2, 0.03], [0.4, 0.1], [0.6, 0.2], [0.8, 0.31], [1, 0.4]].forEach(([stop, alpha]) => {
    falloff.addColorStop(stop, `rgba(3, 5, 12, ${(alpha * intensity).toFixed(3)})`);
  });
  ctx.fillStyle = falloff;
  ctx.fillRect(0, 0, width, height);
  // 2. …and the subject gets a faint warm lift.
  const lift = ctx.createRadialGradient(spotX, spotY, 0, spotX, spotY, spotRadius * 0.55);
  [[0, 0.09], [0.35, 0.05], [0.7, 0.015], [1, 0]].forEach(([stop, alpha]) => {
    lift.addColorStop(stop, `rgba(255, 236, 205, ${(alpha * intensity).toFixed(3)})`);
  });
  ctx.fillStyle = lift;
  ctx.fillRect(0, 0, width, height);

  // One soft light ray from the top corner, fading out before it reaches the subject.
  ctx.translate(width * 0.12, -height * 0.05);
  ctx.rotate(Math.atan2(spotY + height * 0.05, spotX - width * 0.12));
  const beamLen = Math.hypot(spotX - width * 0.12, spotY + height * 0.05);
  const beamGrad = ctx.createLinearGradient(0, 0, beamLen, 0);
  beamGrad.addColorStop(0, `rgba(255, 240, 205, ${(0.13 * intensity).toFixed(3)})`);
  beamGrad.addColorStop(0.7, `rgba(255, 228, 178, ${(0.035 * intensity).toFixed(3)})`);
  beamGrad.addColorStop(1, 'rgba(255, 228, 178, 0)');
  ctx.fillStyle = beamGrad;
  ctx.beginPath();
  ctx.moveTo(0, -width * 0.03);
  ctx.lineTo(beamLen, -width * 0.2);
  ctx.lineTo(beamLen, width * 0.2);
  ctx.lineTo(0, width * 0.03);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ============================================================================
   PRESET 3: Mystery Fog + Rolling Mist
   ============================================================================ */
function renderMysteryFog(ctx, fx) {
  const { t, width, height, intensity } = fx;
  const rng = seededRandom(303);
  ctx.save();

  // Cool shadow tint for mood.
  ctx.fillStyle = `rgba(10, 22, 38, ${(0.16 * intensity).toFixed(3)})`;
  ctx.fillRect(0, 0, width, height);

  // Rolling fog banks low in the frame. Depth-aware: banks that would cover the
  // subject thin out, so the mist frames it instead of hiding it.
  const puffCount = 16;
  for (let i = 0; i < puffCount; i++) {
    const depth = 0.6 + rng() * 1.2;
    const baseY = height * (0.5 + rng() * 0.5);
    const baseX = rng() * width;
    const puffRadius = width * (0.26 + rng() * 0.3);
    const driftSpeed = (16 + rng() * 26) * depth * (i % 2 === 0 ? 1 : -1) * (width / 1080);
    const span = width + puffRadius * 2;
    const wx = ((((baseX + driftSpeed * t) % span) + span) % span) - puffRadius;
    const wy = baseY + Math.sin(t * 0.6 + i) * (height * 0.012);
    const p = parallaxPoint(wx, wy, depth, fx);
    const clearance = subjectClearance(p.x, p.y, fx, 0.35);
    const alpha = (0.085 + 0.03 * Math.sin(t * 0.8 + i * 0.7)) * intensity * clearance;
    if (alpha < 0.01) continue;

    const r = puffRadius * p.k;
    const fogGrad = ctx.createRadialGradient(p.x, p.y, r * 0.1, p.x, p.y, r);
    fogGrad.addColorStop(0, `rgba(200, 220, 238, ${alpha.toFixed(3)})`);
    fogGrad.addColorStop(0.55, `rgba(160, 185, 210, ${(alpha * 0.5).toFixed(3)})`);
    fogGrad.addColorStop(1, 'rgba(160, 185, 210, 0)');
    ctx.fillStyle = fogGrad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Slow breathing of the edge shadow (suspense), far below flicker rate.
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 0.5);
  const pulseGrad = ctx.createRadialGradient(width * 0.5, height * 0.45, width * 0.22, width * 0.5, height * 0.5, Math.max(width, height) * 0.68);
  pulseGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  pulseGrad.addColorStop(1, `rgba(2, 5, 12, ${((0.26 + pulse * 0.1) * intensity).toFixed(3)})`);
  ctx.fillStyle = pulseGrad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/* ============================================================================
   PRESET 4: Sci-Fi Cyber Grid + Scanline + RGB Glitch Slices
   ============================================================================ */
function renderSciFiGlitch(ctx, fx) {
  const { t, width, height, intensity, drawCoverImage, beats } = fx;
  const frameIndex = Math.floor(t * FIXED_FPS);
  const rng = seededRandom(frameIndex * 131 + 7);

  ctx.save();
  // Faint HUD grid
  const gridStep = Math.round(width / 12);
  ctx.strokeStyle = `rgba(0, 240, 255, ${(0.05 * intensity).toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= width; x += gridStep) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += gridStep) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Scanline sweep
  const scanY = ((t * height * 0.34) % height + height) % height;
  const scanGrad = ctx.createLinearGradient(0, scanY - 40, 0, scanY + 12);
  scanGrad.addColorStop(0, 'rgba(0, 240, 255, 0)');
  scanGrad.addColorStop(0.8, `rgba(0, 240, 255, ${(0.12 * intensity).toFixed(3)})`);
  scanGrad.addColorStop(1, `rgba(180, 255, 255, ${(0.34 * intensity).toFixed(3)})`);
  ctx.fillStyle = scanGrad;
  ctx.fillRect(0, scanY - 40, width, 52);

  // Glitch bursts are an accent, not a constant flicker: three frames on each
  // emphasis beat (or once every ~1.6s when the text has no beats).
  const onBeat = beats.length
    ? beats.some((b) => {
        const f = frameIndex - Math.round(b.t * FIXED_FPS);
        return f >= 0 && f < 3;
      })
    : frameIndex % 48 >= 20 && frameIndex % 48 < 23;
  if (onBeat && intensity > 0.2 && typeof drawCoverImage === 'function') {
    for (let s = 0; s < 4; s++) {
      const sliceY = rng() * height;
      const sliceH = (10 + rng() * 40) * (height / 1920);
      const shiftX = (rng() - 0.5) * 30 * (width / 1080) * intensity;
      // Keep slices off the subject so the glitch never breaks the main composition.
      if (subjectClearance(width / 2, sliceY + sliceH / 2, fx, 0) < 0.5) continue;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, sliceY, width, sliceH);
      ctx.clip();
      ctx.translate(shiftX, 0);
      drawCoverImage(ctx);
      ctx.fillStyle = s % 2 === 0 ? 'rgba(0, 255, 255, 0.12)' : 'rgba(255, 0, 128, 0.12)';
      ctx.fillRect(-Math.abs(shiftX), sliceY, width + Math.abs(shiftX) * 2, sliceH);
      ctx.restore();
    }
  }

  // HUD corner brackets
  const pad = Math.round(width * 0.045);
  const len = Math.round(width * 0.06);
  ctx.strokeStyle = `rgba(0, 240, 255, ${(0.42 * Math.min(1, intensity)).toFixed(3)})`;
  ctx.lineWidth = Math.max(2, width / 360);
  const corners = [
    [pad, pad + len, pad, pad, pad + len, pad],
    [width - pad - len, pad, width - pad, pad, width - pad, pad + len],
    [pad, height - pad - len, pad, height - pad, pad + len, height - pad],
    [width - pad - len, height - pad, width - pad, height - pad, width - pad, height - pad - len]
  ];
  corners.forEach(([x1, y1, x2, y2, x3, y3]) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.stroke();
  });
  ctx.restore();
}

/* ============================================================================
   PRESET 5: Vintage Film Grain + Edge Light Leak
   ============================================================================ */
function renderVintageFilm(ctx, fx) {
  const { t, width, height, intensity } = fx;
  const frameIndex = Math.floor(t * FIXED_FPS);
  const rng = seededRandom(frameIndex * 313 + 19);

  ctx.save();
  // Warm sepia tone wash
  ctx.fillStyle = `rgba(215, 155, 80, ${(0.07 * intensity).toFixed(3)})`;
  ctx.fillRect(0, 0, width, height);

  // Light leak hugging the frame edge (never drifting across the subject).
  const leakX = width * (-0.06 + 0.07 * Math.sin(t * 0.7));
  const leakY = height * (0.3 + 0.16 * Math.cos(t * 0.5));
  const leakRadius = Math.max(width, height) * 0.42;
  const leakGrad = ctx.createRadialGradient(leakX, leakY, 10, leakX, leakY, leakRadius);
  leakGrad.addColorStop(0, `rgba(255, 150, 50, ${(0.2 * intensity).toFixed(3)})`);
  leakGrad.addColorStop(0.45, `rgba(255, 80, 60, ${(0.07 * intensity).toFixed(3)})`);
  leakGrad.addColorStop(1, 'rgba(255, 60, 30, 0)');
  ctx.fillStyle = leakGrad;
  ctx.fillRect(0, 0, width, height);

  // Exposure breathing as smooth noise: a real projector drifts, it does not strobe.
  const breathe = smoothNoise(t * 3, 5) * 0.012 * intensity;
  if (breathe > 0) {
    ctx.fillStyle = `rgba(255, 245, 220, ${breathe.toFixed(4)})`;
    ctx.fillRect(0, 0, width, height);
  }

  // Occasional hairline scratch
  if (rng() > 0.72) {
    const sx = width * (0.12 + rng() * 0.76);
    ctx.strokeStyle = `rgba(255, 245, 220, ${((0.05 + rng() * 0.08) * intensity).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, width / 1000);
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx + (rng() - 0.5) * 6, height);
    ctx.stroke();
  }

  // Fine grain
  const speckCount = Math.round(180 * Math.min(1.2, intensity));
  for (let i = 0; i < speckCount; i++) {
    const gx = rng() * width;
    const gy = rng() * height;
    const gSize = (1 + rng() * 1.6) * (width / 1080);
    ctx.fillStyle = rng() > 0.45 ? 'rgba(255, 245, 225, 0.11)' : 'rgba(15, 10, 5, 0.16)';
    ctx.fillRect(gx, gy, gSize, gSize);
  }
  ctx.restore();
}

/**
 * Subtle film grade over the base image (before effects): a warm or cool
 * tint from the preset's `warmth`, applied with soft-light so highlights and
 * shadows keep their detail.
 */
export function renderFilmGrade(ctx, { width, height, warmth = 0, intensity = 1 }) {
  const amount = Math.max(-1, Math.min(1, Number(warmth) || 0)) * Math.min(1, intensity);
  if (Math.abs(amount) < 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = amount > 0 ? `rgba(255, 176, 96, ${(amount * 0.55).toFixed(3)})` : `rgba(96, 156, 255, ${(-amount * 0.55).toFixed(3)})`;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
