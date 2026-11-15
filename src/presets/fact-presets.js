// Deterministic, time-driven Fact-Short presets (30 FPS constant frame rate, 1080p minimum)
// Plain ES Module — works in Browser, Antigravity, Claude Desktop, and Codex.

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
      particleCount: 90,
      vignetteStrength: 0.72,
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
      vignetteStrength: 0.82,
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
      vignetteStrength: 0.86,
      warmth: -0.14
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
      vignetteStrength: 0.75,
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
      vignetteStrength: 0.78,
      warmth: 0.22
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

/**
 * Compute deterministic camera transform at time `t` (seconds) for the active preset & scenePlan
 */
export function computeCameraTransform(t, duration, presetId, scenePlan = {}) {
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

  // Preset-specific camera motion modulation
  if (presetId === 'mystery-fog-shake') {
    // Organic handheld documentary camera sway
    const shakeAmp = Number(scenePlan.shakeIntensity ?? 0.008);
    offsetX += Math.sin(t * 4.7) * shakeAmp + Math.cos(t * 9.3) * (shakeAmp * 0.4);
    offsetY += Math.cos(t * 5.3) * shakeAmp + Math.sin(t * 8.1) * (shakeAmp * 0.4);
    rotationRad += Math.sin(t * 3.2) * 0.004;
  } else if (presetId === 'vintage-film-grain') {
    // Subtle 16mm projector gate weave
    const frameIndex = Math.floor(t * FIXED_FPS);
    const rng = seededRandom(frameIndex * 997 + 42);
    offsetX += (rng() - 0.5) * 0.0025;
    offsetY += (rng() - 0.5) * 0.0025;
  } else if (presetId === '3d-perspective-tilt') {
    // Smooth orbital arc
    offsetX += Math.sin(progress * Math.PI) * 0.018;
  }

  // Natural handheld: layered slow drift + tiny fast tremor, deterministic.
  // A locked-off camera reads as a slideshow; a real handheld camera
  // never sits perfectly still, but it never jerks either.
  offsetX += Math.sin(t * 0.9 + 1.2) * 0.0035 + Math.sin(t * 2.3) * 0.0012;
  offsetY += Math.cos(t * 0.7) * 0.0035 + Math.sin(t * 1.9 + 0.6) * 0.0012;
  rotationRad += Math.sin(t * 0.8 + 0.4) * 0.0018;

  return { scale, offsetX, offsetY, rotationRad, progress, eased };
}

/**
 * Render preset-specific atmospheric & VFX overlays onto `ctx` at exact timestamp `t`
 */
export function renderPresetEffects(ctx, { presetId, t, duration, width, height, scenePlan = {}, drawCoverImage }) {
  switch (presetId) {
    case 'documentary-kenburns':
      renderDocumentaryDust(ctx, t, duration, width, height, scenePlan);
      break;
    case '3d-perspective-tilt':
      render3DSpotlight(ctx, t, duration, width, height, scenePlan);
      break;
    case 'mystery-fog-shake':
      renderMysteryFog(ctx, t, duration, width, height, scenePlan);
      break;
    case 'scifi-cyber-glitch':
      renderSciFiGlitch(ctx, t, duration, width, height, scenePlan, drawCoverImage);
      break;
    case 'vintage-film-grain':
      renderVintageFilm(ctx, t, duration, width, height, scenePlan);
      break;
    default:
      renderDocumentaryDust(ctx, t, duration, width, height, scenePlan);
      break;
  }
}

/* ============================================================================
   PRESET 1: Documentary Ken Burns + Floating Golden Dust Motes
   ============================================================================ */
function renderDocumentaryDust(ctx, t, duration, width, height, scenePlan) {
  const count = Number(scenePlan.particleCount ?? 65);
  const rng = seededRandom(101);
  const accentColor = scenePlan.accentColor || '255, 225, 155';

  ctx.save();
  // Warm sunlight wash from top-right
  const sunGrad = ctx.createRadialGradient(
    width * 0.82,
    height * 0.14,
    width * 0.02,
    width * 0.82,
    height * 0.14,
    width * 0.95
  );
  sunGrad.addColorStop(0, `rgba(${accentColor}, 0.22)`);
  sunGrad.addColorStop(0.5, `rgba(${accentColor}, 0.06)`);
  sunGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = sunGrad;
  ctx.fillRect(0, 0, width, height);

  // Deterministic floating dust motes with depth layers
  for (let i = 0; i < count; i++) {
    const startX = rng() * width;
    const startY = rng() * height;
    const depth = 0.4 + rng() * 1.6; // parallax depth
    const radius = (2.5 + rng() * 6.0) * (width / 1080) * (depth * 0.75);
    const speedY = (40 + rng() * 70) * depth;
    const speedX = (rng() - 0.5) * 28 * depth;
    const phase = rng() * Math.PI * 2;

    const x = (((startX + speedX * t + Math.sin(t * 1.8 + phase) * 18) % width) + width) % width;
    const y = (((startY - speedY * t) % height) + height) % height;
    const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 3.4 + phase));
    const alpha = Math.min(0.9, (0.35 + rng() * 0.55) * twinkle);

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${accentColor}, ${alpha.toFixed(3)})`;
    ctx.shadowBlur = 12 * (width / 1080);
    ctx.shadowColor = `rgba(${accentColor}, 0.8)`;
    ctx.fill();
  }
  ctx.restore();
}

/* ============================================================================
   PRESET 2: 3D Perspective Tilt + Volumetric Spotlight + Specular Rays
   ============================================================================ */
function render3DSpotlight(ctx, t, duration, width, height, scenePlan) {
  const progress = t / Math.max(0.1, duration);
  const focusX = Number(scenePlan.focusX ?? 0.5);
  const focusY = Number(scenePlan.focusY ?? 0.42);

  // Spotlight sweeps across the subject focal zone
  const spotX = width * (focusX + Math.sin(progress * Math.PI * 2) * 0.18);
  const spotY = height * (focusY + Math.cos(progress * Math.PI * 2) * 0.1);
  const spotRadius = Math.max(width, height) * 0.52;

  ctx.save();
  // Darken outer room while illuminating the subject cone
  const spotGrad = ctx.createRadialGradient(spotX, spotY, spotRadius * 0.08, spotX, spotY, spotRadius);
  spotGrad.addColorStop(0, 'rgba(255, 250, 235, 0.24)');
  spotGrad.addColorStop(0.35, 'rgba(255, 220, 165, 0.08)');
  spotGrad.addColorStop(0.75, 'rgba(5, 8, 18, 0.52)');
  spotGrad.addColorStop(1, 'rgba(0, 0, 0, 0.78)');
  ctx.fillStyle = spotGrad;
  ctx.fillRect(0, 0, width, height);

  // Volumetric god-ray beam from top corner toward spotlight center
  ctx.translate(width * 0.15, -height * 0.05);
  const angle = Math.atan2(spotY + height * 0.05, spotX - width * 0.15);
  ctx.rotate(angle);
  const beamLen = Math.hypot(width, height);
  const beamGrad = ctx.createLinearGradient(0, 0, beamLen, 0);
  beamGrad.addColorStop(0, 'rgba(255, 240, 200, 0.22)');
  beamGrad.addColorStop(0.6, 'rgba(255, 225, 170, 0.07)');
  beamGrad.addColorStop(1, 'rgba(255, 225, 170, 0)');
  ctx.fillStyle = beamGrad;
  ctx.beginPath();
  ctx.moveTo(0, -width * 0.04);
  ctx.lineTo(beamLen, -width * 0.28);
  ctx.lineTo(beamLen, width * 0.28);
  ctx.lineTo(0, width * 0.04);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Subtle 3D perspective frame border lines
  ctx.save();
  const inset = Math.round(width * 0.045);
  const tiltShift = Math.sin(progress * Math.PI * 2) * (width * 0.012);
  ctx.strokeStyle = 'rgba(255, 230, 170, 0.22)';
  ctx.lineWidth = Math.max(2, width / 540);
  ctx.beginPath();
  ctx.moveTo(inset + tiltShift, inset);
  ctx.lineTo(width - inset + tiltShift, inset);
  ctx.lineTo(width - inset - tiltShift, height - inset);
  ctx.lineTo(inset - tiltShift, height - inset);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/* ============================================================================
   PRESET 3: Mystery Fog + Rolling Mist + Cold Shadow Pulse
   ============================================================================ */
function renderMysteryFog(ctx, t, duration, width, height, scenePlan) {
  const rng = seededRandom(303);
  ctx.save();

  // Cold moody cyan/indigo shadow tint
  ctx.fillStyle = 'rgba(10, 22, 38, 0.24)';
  ctx.fillRect(0, 0, width, height);

  // Multi-layered procedural rolling fog banks
  const puffCount = 26;
  for (let i = 0; i < puffCount; i++) {
    const baseY = height * (0.25 + rng() * 0.72);
    const baseX = rng() * width;
    const puffRadius = width * (0.28 + rng() * 0.38);
    const driftSpeed = (35 + rng() * 55) * (i % 2 === 0 ? 1 : -1);
    const x = (((baseX + driftSpeed * t) % (width + puffRadius * 2)) + (width + puffRadius * 2)) %
      (width + puffRadius * 2) - puffRadius;
    const y = baseY + Math.sin(t * 1.1 + i) * (height * 0.02);
    const alpha = 0.12 + 0.08 * Math.sin(t * 1.5 + i * 0.7);

    const fogGrad = ctx.createRadialGradient(x, y, puffRadius * 0.1, x, y, puffRadius);
    fogGrad.addColorStop(0, `rgba(200, 220, 238, ${alpha.toFixed(3)})`);
    fogGrad.addColorStop(0.55, `rgba(160, 185, 210, ${(alpha * 0.5).toFixed(3)})`);
    fogGrad.addColorStop(1, 'rgba(160, 185, 210, 0)');

    ctx.fillStyle = fogGrad;
    ctx.beginPath();
    ctx.arc(x, y, puffRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Heartbeat mystery darkness pulse around edges
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 1.5);
  const pulseGrad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.45,
    width * 0.18,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.65
  );
  pulseGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  pulseGrad.addColorStop(1, `rgba(2, 5, 12, ${(0.45 + pulse * 0.25).toFixed(3)})`);
  ctx.fillStyle = pulseGrad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/* ============================================================================
   PRESET 4: Sci-Fi Cyber Grid + Scanline + RGB Glitch Slices
   ============================================================================ */
function renderSciFiGlitch(ctx, t, duration, width, height, scenePlan, drawCoverImage) {
  const frameIndex = Math.floor(t * FIXED_FPS);
  const rng = seededRandom(frameIndex * 131 + 7);

  ctx.save();
  // Subtle cyber grid overlay
  const gridStep = Math.round(width / 12);
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.07)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += gridStep) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += gridStep) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Sweeping laser scanline beam
  const scanY = ((t * height * 0.42) % height + height) % height;
  const scanGrad = ctx.createLinearGradient(0, scanY - 40, 0, scanY + 12);
  scanGrad.addColorStop(0, 'rgba(0, 240, 255, 0)');
  scanGrad.addColorStop(0.8, 'rgba(0, 240, 255, 0.22)');
  scanGrad.addColorStop(1, 'rgba(180, 255, 255, 0.65)');
  ctx.fillStyle = scanGrad;
  ctx.fillRect(0, scanY - 40, width, 52);

  // Periodic deterministic glitch burst (every ~0.8s for 4 frames)
  const isGlitchWindow = frameIndex % 24 < 4 || frameIndex % 37 === 0;
  if (isGlitchWindow && typeof drawCoverImage === 'function') {
    const sliceCount = 5;
    for (let s = 0; s < sliceCount; s++) {
      const sliceY = rng() * height;
      const sliceH = (12 + rng() * 55) * (height / 1920);
      const shiftX = (rng() - 0.5) * 44 * (width / 1080);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, sliceY, width, sliceH);
      ctx.clip();
      ctx.translate(shiftX, 0);
      drawCoverImage();
      // Cyan/Magenta chromatic tint on displaced slice
      ctx.fillStyle = s % 2 === 0 ? 'rgba(0, 255, 255, 0.18)' : 'rgba(255, 0, 128, 0.18)';
      ctx.fillRect(0, sliceY, width, sliceH);
      ctx.restore();
    }
  }

  // HUD Corner Brackets
  const pad = Math.round(width * 0.045);
  const len = Math.round(width * 0.06);
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.55)';
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
   PRESET 5: Vintage 16mm/35mm Film Grain + Organic Light Leaks + Scratches
   ============================================================================ */
function renderVintageFilm(ctx, t, duration, width, height, scenePlan) {
  const frameIndex = Math.floor(t * FIXED_FPS);
  const rng = seededRandom(frameIndex * 313 + 19);

  ctx.save();
  // Warm sepia/amber vintage tone wash
  ctx.fillStyle = 'rgba(215, 155, 80, 0.10)';
  ctx.fillRect(0, 0, width, height);

  // Organic sweeping amber/coral light leaks on frame edges
  const leakX = width * (0.12 + 0.15 * Math.sin(t * 1.9));
  const leakY = height * (0.25 + 0.2 * Math.cos(t * 1.3));
  const leakRadius = Math.max(width, height) * 0.55;
  const leakGrad = ctx.createRadialGradient(leakX, leakY, 10, leakX, leakY, leakRadius);
  leakGrad.addColorStop(0, 'rgba(255, 150, 50, 0.34)');
  leakGrad.addColorStop(0.45, 'rgba(255, 80, 60, 0.16)');
  leakGrad.addColorStop(1, 'rgba(255, 60, 30, 0)');
  ctx.fillStyle = leakGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle projector shutter flicker
  const flicker = (rng() - 0.5) * 0.05;
  if (flicker > 0) {
    ctx.fillStyle = `rgba(255, 245, 220, ${flicker.toFixed(3)})`;
    ctx.fillRect(0, 0, width, height);
  }

  // Deterministic film dust specks & vertical celluloid scratches
  const scratchCount = 2;
  for (let s = 0; s < scratchCount; s++) {
    if (rng() > 0.35) {
      const sx = width * (0.15 + rng() * 0.7);
      ctx.strokeStyle = `rgba(255, 245, 220, ${(0.08 + rng() * 0.14).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, width / 900);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx + (rng() - 0.5) * 8, height);
      ctx.stroke();
    }
  }

  // Coarse 16mm grain specks
  const speckCount = 220;
  for (let i = 0; i < speckCount; i++) {
    const gx = rng() * width;
    const gy = rng() * height;
    const gSize = (1.5 + rng() * 3.0) * (width / 1080);
    const isLight = rng() > 0.45;
    ctx.fillStyle = isLight ? 'rgba(255, 245, 225, 0.16)' : 'rgba(15, 10, 5, 0.22)';
    ctx.fillRect(gx, gy, gSize, gSize);
  }
  ctx.restore();
}
