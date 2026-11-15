// Core 1080p+ / 30 FPS Frame-Accurate Renderer Engine
// Plain ES Module — shared by live preview AND frame-by-frame video export.

import {
  FIXED_FPS,
  getResolutionDims,
  computeCameraTransform,
  renderPresetEffects,
  seededRandom
} from '../presets/fact-presets.js';

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
export function drawImageCover(ctx, img, canvasW, canvasH, focusX = 0.5, focusY = 0.5, overscan = 1.12) {
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
 * Render the cinematic edge vignette
 */
function renderVignette(ctx, width, height, strength = 0.75) {
  const clamped = Math.max(0, Math.min(1, Number(strength ?? 0.75)));
  if (clamped <= 0.01) return;

  ctx.save();
  const radius = Math.max(width, height) * 0.68;
  const grad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.46,
    Math.min(width, height) * 0.22,
    width * 0.5,
    height * 0.5,
    radius
  );
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(0.65, `rgba(0, 0, 0, ${(clamped * 0.45).toFixed(3)})`);
  grad.addColorStop(1, `rgba(0, 0, 0, ${(clamped * 0.92).toFixed(3)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/**
 * Render word-wrapped Fact Title & Subtitle inside 9:16 Shorts / 16:9 Widescreen safe zones
 */
function renderFactCaptions(ctx, { t, width, height, aspectRatio, factTitle, factSubtitle, scenePlan = {} }) {
  const titleText = String(factTitle ?? scenePlan.factTitle ?? '').trim();
  const subText = String(factSubtitle ?? scenePlan.factSubtitle ?? '').trim();
  if (!titleText && !subText) return;

  const scaleFactor = aspectRatio === '9:16' ? width / 1080 : height / 1080;
  const maxTextWidth = Math.round(width * (aspectRatio === '9:16' ? 0.82 : 0.74));

  // Smooth entrance animation during first 0.4s
  const enterProgress = Math.max(0, Math.min(1, t / 0.4));
  const easeEnter = 1 - Math.pow(1 - enterProgress, 3);
  const slideOffsetY = (1 - easeEnter) * 28 * scaleFactor;

  ctx.save();
  ctx.globalAlpha = easeEnter;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const titleFontSize = Math.round((aspectRatio === '9:16' ? 54 : 44) * scaleFactor);
  const subFontSize = Math.round((aspectRatio === '9:16' ? 32 : 26) * scaleFactor);
  const titleLineHeight = Math.round(titleFontSize * 1.18);
  const subLineHeight = Math.round(subFontSize * 1.34);

  ctx.font = `900 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const titleLines = wrapTextLines(ctx, titleText.toUpperCase(), maxTextWidth);

  ctx.font = `600 ${subFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const subLines = wrapTextLines(ctx, subText, maxTextWidth);

  const gapBetween = titleLines.length > 0 && subLines.length > 0 ? Math.round(16 * scaleFactor) : 0;
  const totalBlockHeight =
    titleLines.length * titleLineHeight + gapBetween + subLines.length * subLineHeight;

  // Safe bottom margin: 9:16 Shorts reserve bottom 240px for platform UI; 16:9 reserves 75px
  const safeBottomMargin = Math.round((aspectRatio === '9:16' ? 240 : 75) * scaleFactor);
  const blockTopY = height - safeBottomMargin - totalBlockHeight + slideOffsetY;

  // Subtle dark gradient backdrop card behind captions for guaranteed readability
  const padX = Math.round(28 * scaleFactor);
  const padY = Math.round(22 * scaleFactor);
  const cardWidth = maxTextWidth + padX * 2;
  const cardHeight = totalBlockHeight + padY * 2;
  const cardX = (width - cardWidth) / 2;
  const cardY = blockTopY - padY;

  ctx.fillStyle = 'rgba(6, 9, 16, 0.62)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = Math.max(1.5, 2 * scaleFactor);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(cardX, cardY, cardWidth, cardHeight, Math.round(18 * scaleFactor));
  } else {
    ctx.rect(cardX, cardY, cardWidth, cardHeight);
  }
  ctx.fill();
  ctx.stroke();

  let cursorY = blockTopY;

  // Draw Title Lines
  if (titleLines.length > 0) {
    ctx.font = `900 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    const titleColor = scenePlan.titleColor || '#ffd166';
    for (const line of titleLines) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 16 * scaleFactor;
      ctx.shadowOffsetY = 4 * scaleFactor;
      ctx.fillStyle = titleColor;
      ctx.fillText(line, width / 2, cursorY);
      cursorY += titleLineHeight;
    }
  }

  cursorY += gapBetween;

  // Draw Subtitle Lines
  if (subLines.length > 0) {
    ctx.font = `600 ${subFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    for (const line of subLines) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.92)';
      ctx.shadowBlur = 12 * scaleFactor;
      ctx.shadowOffsetY = 3 * scaleFactor;
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(line, width / 2, cursorY);
      cursorY += subLineHeight;
    }
  }

  ctx.restore();
}

/**
 * Render a single deterministic frame at timestamp `t` (in seconds) onto `ctx`.
 * At 30 FPS, frame index `n` corresponds to `t = n / 30`.
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
  customDrawFn = null
}) {
  const { width, height } = getResolutionDims(aspectRatio, resolution);

  // Ensure canvas pixel buffer matches exact target resolution
  if (ctx.canvas.width !== width) ctx.canvas.width = width;
  if (ctx.canvas.height !== height) ctx.canvas.height = height;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  const focusX = Number(scenePlan.focusX ?? 0.5);
  const focusY = Number(scenePlan.focusY ?? 0.45);

  // 1. Camera Transform + Cover-Fit Base Image
  const cam = computeCameraTransform(t, duration, presetId, scenePlan);

  const drawTransformedCover = () => {
    if (!img) return;
    ctx.save();
    ctx.translate(width * 0.5 + cam.offsetX * width, height * 0.5 + cam.offsetY * height);
    ctx.rotate(cam.rotationRad);
    ctx.scale(cam.scale, cam.scale);
    ctx.translate(-width * 0.5, -height * 0.5);
    drawImageCover(ctx, img, width, height, focusX, focusY, 1.14);
    ctx.restore();
  };

  drawTransformedCover();

  // 2. Preset Atmospheric & Shader-style Canvas Effects
  renderPresetEffects(ctx, {
    presetId,
    t,
    duration,
    width,
    height,
    scenePlan,
    drawCoverImage: drawTransformedCover
  });

  // 3. Optional Custom Scene Code Hook (from Live Code Editor or Agent-Generated Scene)
  if (typeof customDrawFn === 'function') {
    try {
      ctx.save();
      customDrawFn(ctx, {
        t,
        frame: Math.floor(t * FIXED_FPS),
        fps: FIXED_FPS,
        duration,
        progress: cam.progress,
        width,
        height,
        focusX,
        focusY,
        seededRandom
      });
      ctx.restore();
    } catch (err) {
      // Prevent broken user snippet from crashing the render loop
    }
  }

  // 4. Edge Vignette
  renderVignette(ctx, width, height, scenePlan.vignetteStrength ?? 0.75);

  // 5. Word-Wrapped Safe-Zone Fact Captions
  renderFactCaptions(ctx, {
    t,
    width,
    height,
    aspectRatio,
    factTitle,
    factSubtitle,
    scenePlan
  });

  ctx.restore();

  return {
    frame: Math.floor(t * FIXED_FPS),
    totalFrames: Math.round(duration * FIXED_FPS),
    fps: FIXED_FPS,
    width,
    height
  };
}
