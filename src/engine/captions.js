// Caption engine — phrase captions for Shorts in English, Hindi and Hinglish.
//
// Layout is separated from drawing: `layoutCaptions` is a pure function of a
// `measure(text, fontPx, weight)` callback, so line breaking, font fitting and
// safe-zone placement are unit-testable in Node with a fake measurer, and the
// quality inspector can check bounds without rendering anything.
//
// Devanagari: words are always measured and drawn whole (never split inside a
// word), so the browser's shaping engine forms conjuncts and places matras
// correctly. Line height is taller for Devanagari to clear upper/lower marks.

const DEVANAGARI = /[ऀ-ॿ]/;

// System UI font first (San Francisco on macOS, Segoe UI on Windows) — clean,
// heavy weights, no web-font download. Devanagari falls through to the
// platform's Devanagari face (Kohinoor on macOS, Nirmala UI on Windows).
export const CAPTION_FONT_STACK =
  'system-ui, -apple-system, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", ' +
  '"Kohinoor Devanagari", "Noto Sans Devanagari", "Nirmala UI", "Mangal", Arial, sans-serif';

export function scriptOf(text) {
  return DEVANAGARI.test(String(text || '')) ? 'devanagari' : 'latin';
}

export function fontString(fontPx, weight = 800) {
  return `${weight} ${Math.round(fontPx)}px ${CAPTION_FONT_STACK}`;
}

export const DEFAULT_CAPTION_STYLE = Object.freeze({
  mode: 'phrases', // 'phrases' | 'static'
  backdrop: 'auto', // 'auto' | 'none' | 'scrim' | 'card'
  textColor: '#ffffff',
  accentColor: '#ffd166',
  outlineColor: 'rgba(6, 8, 12, 0.94)',
  maxLines: 2,
  sizeScale: 1,
  // Share of the frame kept clear at the bottom for the platform's own UI
  // (channel name, description, progress bar). 9:16 Shorts need far more than 16:9.
  safeBottom: null,
  safeSide: null
});

/** Pixel safe zone for captions, per aspect ratio. */
export function captionSafeZone({ width, height, aspectRatio = '9:16', style = {} }) {
  const vertical = aspectRatio === '9:16';
  const safeBottom = style.safeBottom ?? (vertical ? 0.17 : 0.08);
  const safeSide = style.safeSide ?? (vertical ? 0.1 : 0.19);
  return {
    left: Math.round(width * safeSide),
    right: Math.round(width * (1 - safeSide)),
    top: Math.round(height * (vertical ? 0.07 : 0.06)),
    bottom: Math.round(height * (1 - safeBottom)),
    maxTextWidth: Math.round(width * (1 - 2 * safeSide)),
    scale: vertical ? width / 1080 : height / 1080
  };
}

/** Greedy wrap, then rebalance two lines so they are close to equal width. */
function wrapWords(words, widths, spaceW, maxWidth) {
  const lines = [];
  let line = [];
  let lineW = 0;
  words.forEach((w, i) => {
    const add = widths[i] + (line.length ? spaceW : 0);
    if (line.length && lineW + add > maxWidth) {
      lines.push(line);
      line = [];
      lineW = 0;
    }
    lineW += widths[i] + (line.length ? spaceW : 0);
    line.push(i);
  });
  if (line.length) lines.push(line);

  if (lines.length === 2) {
    const widthOf = (idx) => idx.reduce((s, i, k) => s + widths[i] + (k ? spaceW : 0), 0);
    const all = [...lines[0], ...lines[1]];
    let best = lines[0].length;
    let bestDiff = Infinity;
    for (let cut = 1; cut < all.length; cut++) {
      const a = widthOf(all.slice(0, cut));
      const b = widthOf(all.slice(cut));
      if (a > maxWidth || b > maxWidth) continue;
      // Slightly prefer a longer first line: it reads more naturally than a short orphan on top.
      const diff = Math.abs(a - b) + (a < b ? maxWidth * 0.04 : 0);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = cut;
      }
    }
    return [all.slice(0, best), all.slice(best)];
  }
  return lines;
}

/**
 * Fit one cue: the largest font (between base and minimum) at which the text
 * needs at most `maxLines` lines. If a single word is wider than the line the
 * font shrinks further so nothing is ever clipped.
 */
export function fitCue(measure, cue, { maxWidth, baseFont, minFont, maxLines = 2, weight = 800 }) {
  const texts = cue.words.map((w) => w.text);
  let fontPx = baseFont;
  let lines = null;
  let widths = null;
  let spaceW = 0;

  for (let guard = 0; guard < 40; guard++) {
    widths = texts.map((t) => measure(t, fontPx, weight));
    spaceW = fontPx * 0.27;
    const widest = Math.max(0, ...widths);
    if (widest > maxWidth) {
      // One word does not fit on a line: shrink to fit it (clipping is never acceptable).
      fontPx = Math.max(12, Math.floor(fontPx * Math.min(0.96, maxWidth / widest)));
      continue;
    }
    lines = wrapWords(texts, widths, spaceW, maxWidth);
    if (lines.length <= maxLines || fontPx <= minFont) break;
    fontPx = Math.max(minFont, Math.floor(fontPx * 0.95));
  }

  return { fontPx, lines, widths, spaceW, overflow: lines.length > maxLines };
}

function positionCue(cue, fit, { centerX, lineHeight }) {
  const lines = fit.lines.map((indices, row) => {
    const lineW = indices.reduce((s, i, k) => s + fit.widths[i] + (k ? fit.spaceW : 0), 0);
    let x = centerX - lineW / 2;
    const words = indices.map((i) => {
      const word = {
        index: i,
        text: cue.words[i].text,
        emphasis: Boolean(cue.words[i].emphasis),
        start: cue.words[i].start,
        end: cue.words[i].end,
        x,
        width: fit.widths[i]
      };
      x += fit.widths[i] + fit.spaceW;
      return word;
    });
    return { row, width: lineW, x0: centerX - lineW / 2, yOffset: row * lineHeight, words };
  });
  return {
    id: cue.id,
    start: cue.start,
    end: cue.end,
    text: cue.text,
    lines,
    width: Math.max(0, ...lines.map((l) => l.width)),
    height: lines.length * lineHeight
  };
}

/**
 * Lay out the title chip and every caption cue for a clip.
 * One font size is used for all cues (the smallest any cue needs) so the
 * typography stays consistent from phrase to phrase.
 */
export function layoutCaptions({
  measure,
  width,
  height,
  aspectRatio = '9:16',
  title = '',
  cues = [],
  style = {}
}) {
  const st = { ...DEFAULT_CAPTION_STYLE, ...style };
  const zone = captionSafeZone({ width, height, aspectRatio, style: st });
  const vertical = aspectRatio === '9:16';
  const isStatic = st.mode === 'static';
  const allText = `${title} ${cues.map((c) => c.text).join(' ')}`;
  const script = scriptOf(allText);
  const cueWeight = script === 'devanagari' ? 700 : 800;

  const baseFont = Math.round((isStatic ? (vertical ? 40 : 32) : vertical ? 72 : 52) * zone.scale * st.sizeScale * (script === 'devanagari' ? 0.92 : 1));
  const minFont = Math.round((isStatic ? (vertical ? 30 : 26) : vertical ? 48 : 38) * zone.scale);
  const maxLines = isStatic ? 6 : st.maxLines;

  const usableCues = cues.filter((c) => c.words && c.words.length);
  const fits = usableCues.map((cue) => fitCue(measure, cue, { maxWidth: zone.maxTextWidth, baseFont, minFont, maxLines, weight: cueWeight }));
  const fontPx = fits.length ? Math.min(...fits.map((f) => f.fontPx)) : baseFont;
  const finalFits = usableCues.map((cue) =>
    fitCue(measure, cue, { maxWidth: zone.maxTextWidth, baseFont: fontPx, minFont: Math.min(minFont, fontPx), maxLines, weight: cueWeight })
  );
  const lineHeight = Math.round(fontPx * (script === 'devanagari' ? 1.44 : 1.2));
  const centerX = width / 2;

  const laidOut = usableCues.map((cue, i) => positionCue(cue, finalFits[i], { centerX, lineHeight }));
  const maxCueLines = Math.max(0, ...laidOut.map((c) => c.lines.length));
  const phraseAreaHeight = Math.max(maxCueLines, laidOut.length ? Math.min(maxLines, 2) : 0) * lineHeight;

  // Title chip above the phrase area.
  const titleText = String(title || '').trim();
  let titleBox = null;
  const gap = Math.round(18 * zone.scale);
  if (titleText) {
    const titleScript = scriptOf(titleText);
    const display = titleScript === 'latin' ? titleText.toUpperCase() : titleText;
    let titleFont = Math.round((vertical ? 38 : 30) * zone.scale);
    const padX = Math.round(22 * zone.scale);
    const padY = Math.round(11 * zone.scale);
    let textW = measure(display, titleFont, 800);
    while (textW + padX * 2 > zone.maxTextWidth && titleFont > 16) {
      titleFont -= 2;
      textW = measure(display, titleFont, 800);
    }
    const chipH = Math.round(titleFont * (titleScript === 'devanagari' ? 1.5 : 1.25)) + padY * 2;
    titleBox = {
      text: display,
      fontPx: titleFont,
      weight: 800,
      width: textW + padX * 2,
      height: chipH,
      x: centerX - (textW + padX * 2) / 2,
      y: 0, // set below
      radius: Math.round(chipH * 0.28)
    };
  }

  const blockHeight = (titleBox ? titleBox.height + gap : 0) + phraseAreaHeight;
  const blockTop = zone.bottom - blockHeight;
  if (titleBox) titleBox.y = blockTop;
  const phraseTop = blockTop + (titleBox ? titleBox.height + gap : 0);

  for (const cue of laidOut) {
    cue.top = phraseTop;
    for (const line of cue.lines) line.y = phraseTop + line.yOffset;
  }

  const blockWidth = Math.max(titleBox ? titleBox.width : 0, ...laidOut.map((c) => c.width), 0);
  const outline = fontPx * 0.16;
  const bounds = {
    x0: centerX - blockWidth / 2 - outline,
    y0: blockTop - outline,
    x1: centerX + blockWidth / 2 + outline,
    y1: phraseTop + phraseAreaHeight + outline
  };

  return {
    mode: st.mode,
    script,
    weight: cueWeight,
    fontPx,
    lineHeight,
    zone,
    title: titleBox,
    cues: laidOut,
    phraseTop,
    phraseAreaHeight,
    blockTop,
    blockHeight,
    bounds,
    // Normalised band the whole caption block occupies — the camera keeps the subject above it.
    band: { x0: bounds.x0 / width, y0: bounds.y0 / height, x1: bounds.x1 / width, y1: bounds.y1 / height },
    maxLines: maxCueLines,
    overflow: finalFits.some((f) => f.overflow),
    withinSafeZone:
      bounds.x0 >= zone.left - outline - 1 && bounds.x1 <= zone.right + outline + 1 && bounds.y1 <= zone.bottom + outline + 1 && bounds.y0 >= zone.top
  };
}

function relativeLuminance(cssColor) {
  const m = String(cssColor).match(/^#([0-9a-f]{6})$/i);
  if (!m) return 1;
  const v = parseInt(m[1], 16);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

const easeOutCubic = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);

/** The cue on screen at time `t` (cues are contiguous; the last one holds to the end). */
export function activeCueIndex(cues, t) {
  for (let i = cues.length - 1; i >= 0; i--) {
    if (t >= cues[i].start - 1e-6) return i;
  }
  return -1;
}

/**
 * Draw the caption block for time `t`.
 *  - A short fade/rise/scale entrance per phrase (≈0.2s), no continuous wobble.
 *  - Keywords in the accent colour (at most two per phrase).
 *  - Per-word highlight ONLY when timings are real (`timingSource === 'aligned'`);
 *    with estimated timings the phrase appears as a unit, so the captions never
 *    pretend to be word-synced when they are not.
 */
export function drawCaptions(ctx, layout, { t, style = {}, timingSource = 'estimated', backdrop = 'none' }) {
  if (!layout || (!layout.title && layout.cues.length === 0)) return;
  const st = { ...DEFAULT_CAPTION_STYLE, ...style };
  const scale = layout.zone.scale;
  const width = ctx.canvas ? ctx.canvas.width : layout.zone.right + layout.zone.left;
  const centerX = width / 2;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const blockIn = easeOutCubic(t / 0.3);

  // Adaptive backdrop behind the block (chosen from the measured background, see renderer.prepareScene).
  if (backdrop === 'card') {
    const padX = Math.round(26 * scale);
    const padY = Math.round(20 * scale);
    ctx.globalAlpha = blockIn;
    ctx.fillStyle = 'rgba(7, 9, 15, 0.6)';
    roundedRect(
      ctx,
      layout.zone.left - padX,
      layout.blockTop - padY,
      layout.zone.maxTextWidth + padX * 2,
      layout.blockHeight + padY * 2,
      Math.round(22 * scale)
    );
    ctx.fill();
  } else if (backdrop === 'scrim') {
    const top = layout.blockTop - layout.blockHeight * 0.55;
    const bottom = layout.blockTop + layout.blockHeight * 1.5;
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.38, 'rgba(0, 0, 0, 0.46)');
    grad.addColorStop(0.72, 'rgba(0, 0, 0, 0.46)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.globalAlpha = blockIn;
    ctx.fillStyle = grad;
    ctx.fillRect(0, top, width, bottom - top);
  }

  // Title chip: accent background, dark (or light) text — whichever contrasts.
  if (layout.title) {
    const tb = layout.title;
    const rise = (1 - blockIn) * 14 * scale;
    ctx.globalAlpha = blockIn;
    ctx.fillStyle = st.accentColor;
    roundedRect(ctx, tb.x, tb.y + rise, tb.width, tb.height, tb.radius);
    ctx.fill();
    ctx.font = fontString(tb.fontPx, tb.weight);
    ctx.fillStyle = relativeLuminance(st.accentColor) > 0.35 ? '#0b0d12' : '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(tb.fontPx * 0.04).toFixed(1)}px`;
    ctx.fillText(tb.text, centerX, tb.y + rise + tb.height / 2 + tb.fontPx * 0.04);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  const index = activeCueIndex(layout.cues, t);
  if (index >= 0) {
    const cue = layout.cues[index];
    const isStatic = layout.mode === 'static';
    const since = t - cue.start;
    const enter = isStatic ? blockIn : easeOutCubic(since / 0.2);
    const rise = (1 - enter) * 16 * scale;
    const zoom = 0.965 + 0.035 * enter;
    const pivotY = cue.top + cue.height / 2;
    const fontPx = layout.fontPx;
    const outline = fontPx * 0.16;
    const baselineShift = layout.lineHeight * 0.5 + fontPx * 0.34;

    ctx.translate(centerX, pivotY + rise);
    ctx.scale(zoom, zoom);
    ctx.translate(-centerX, -pivotY);
    ctx.font = fontString(fontPx, layout.weight);

    let ordinal = 0;
    for (const line of cue.lines) {
      const baseline = line.y + baselineShift;
      for (const word of line.words) {
        // Word-by-word entrance is a stylistic cascade, not a claim of audio sync.
        const cascade = isStatic ? 1 : easeOutCubic((since - ordinal * 0.035) / 0.16);
        ordinal++;
        let alpha = enter * cascade;
        let fill = word.emphasis ? st.accentColor : st.textColor;

        if (timingSource === 'aligned' && !isStatic) {
          const spoken = t >= word.start;
          const speaking = t >= word.start && t < word.end;
          alpha = enter * (spoken ? 1 : 0.5);
          if (speaking) fill = st.accentColor;
        }
        if (alpha <= 0.01) continue;

        ctx.globalAlpha = alpha;
        // Outline first (with a soft drop shadow), then a clean fill on top.
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = fontPx * 0.22;
        ctx.shadowOffsetY = fontPx * 0.06;
        ctx.lineWidth = outline;
        ctx.strokeStyle = st.outlineColor;
        ctx.strokeText(word.text, word.x, baseline);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = fill;
        ctx.fillText(word.text, word.x, baseline);
      }
    }
  }

  ctx.restore();
}

/** Measurer backed by a real 2D context. */
export function createCanvasMeasurer(ctx) {
  return (text, fontPx, weight = 800) => {
    ctx.save();
    ctx.font = fontString(fontPx, weight);
    const w = ctx.measureText(text).width;
    ctx.restore();
    return w;
  };
}

/**
 * Deterministic approximate measurer for environments without a canvas
 * (Node tests, CLI planning). Wide enough to be conservative.
 */
export function approximateMeasurer(text, fontPx, weight = 800) {
  let units = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code >= 0x0900 && code <= 0x097f) {
      // Combining marks (matras, virama, nukta, anusvara) add no advance width.
      units += /[ऀ-ःऺ-ॏ॑-ॗॢॣ]/.test(ch) ? 0.08 : 0.74;
    } else if (/[A-ZMW@#%&]/.test(ch)) units += 0.72;
    else if (/[ilj.,;:'!|]/.test(ch)) units += 0.3;
    else if (ch === ' ') units += 0.27;
    else units += 0.56;
  }
  return units * fontPx * (weight >= 700 ? 1.04 : 1);
}
