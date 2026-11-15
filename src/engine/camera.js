// Cinematic camera engine — pure math, no canvas, unit-testable in Node.
//
// A camera state is { scale, offsetX, offsetY, rotationRad } applied to the
// cover-fitted source image about the canvas centre (the same transform the
// renderer has always used). On top of that this module adds:
//   • framings   — "put this image region at this place on screen at this size"
//   • safe bounds — the view can never leave the image (no black borders) and
//                   the planned subject stays inside the caption-free safe area
//   • shots      — eased moves between two framings, evaluated per timestamp
//   • a timeline — several shots with cuts / dissolves between them
// Every function is a pure function of its inputs, so preview === export.

export const DEFAULT_OVERSCAN = 1.14;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clamp01 = (x) => clamp(x, 0, 1);
const lerp = (a, b, k) => a + (b - a) * k;

/** Easing curves. All map [0,1] → [0,1] and are C1-continuous inside the interval. */
export const EASINGS = {
  linear: (x) => clamp01(x),
  // Quintic smootherstep: zero velocity AND zero acceleration at both ends.
  'ease-in-out': (x) => {
    const c = clamp01(x);
    return c * c * c * (c * (c * 6 - 15) + 10);
  },
  // Starts at speed (good right after a cut), decelerates into a rest.
  'ease-out': (x) => 1 - Math.pow(1 - clamp01(x), 3),
  // Starts from rest, accelerates into a cut.
  'ease-in': (x) => Math.pow(clamp01(x), 1.6),
  // Constant-speed drift with a soft landing over the last 30%.
  drift: (x) => {
    const c = clamp01(x);
    const knee = 0.7;
    if (c <= knee) return c * (0.82 / knee);
    const k = (c - knee) / (1 - knee);
    // Hermite segment from (knee, 0.82) with matching slope to (1, 1) with zero slope.
    const slope = (0.82 / knee) * (1 - knee);
    return 0.82 + slope * (k - 2 * k * k + k * k * k) + 0.18 * (3 * k * k - 2 * k * k * k);
  }
};

export function ease(name, x) {
  return (EASINGS[name] || EASINGS['ease-in-out'])(x);
}

/**
 * Geometry of the cover-fitted source image on the canvas — identical to
 * renderer.drawImageCover(), so camera math and drawing always agree.
 */
export function computeCoverGeometry({
  imgW, imgH, canvasW, canvasH,
  focusX = 0.5, focusY = 0.45, overscan = DEFAULT_OVERSCAN
}) {
  const iw = Number(imgW) > 0 ? Number(imgW) : canvasW;
  const ih = Number(imgH) > 0 ? Number(imgH) : canvasH;
  const coverScale = Math.max((canvasW * overscan) / iw, (canvasH * overscan) / ih);
  const drawW = iw * coverScale;
  const drawH = ih * coverScale;
  return {
    canvasW,
    canvasH,
    imgW: iw,
    imgH: ih,
    overscan,
    coverScale,
    drawW,
    drawH,
    destX: -Math.max(0, drawW - canvasW) * clamp01(focusX),
    destY: -Math.max(0, drawH - canvasH) * clamp01(focusY)
  };
}

/** Half-extents (pre-zoom) of the canvas viewport's bounding box under rotation. */
function viewHalfExtents(geom, rotationRad) {
  const c = Math.abs(Math.cos(rotationRad));
  const s = Math.abs(Math.sin(rotationRad));
  return {
    hx: (geom.canvasW / 2) * c + (geom.canvasH / 2) * s,
    hy: (geom.canvasW / 2) * s + (geom.canvasH / 2) * c
  };
}

/** Smallest zoom at which the rotated viewport still fits inside the image. */
export function minZoomForGeometry(geom, rotationRad = 0) {
  const { hx, hy } = viewHalfExtents(geom, rotationRad);
  return Math.max((2 * hx) / geom.drawW, (2 * hy) / geom.drawH);
}

/** Largest zoom before a raster source is upscaled into visible softness. */
export function maxZoomForGeometry(geom, { isVector = false, hardCap = 1.9, minSourcePixelsPerOutputPixel = 0.55 } = {}) {
  const floor = minZoomForGeometry(geom) * 1.2;
  if (isVector) return Math.max(floor, hardCap);
  const cap = 1 / (minSourcePixelsPerOutputPixel * geom.coverScale);
  return Math.max(floor, Math.min(hardCap, cap));
}

/** Viewport centre in pre-transform (cover-image) pixel space. */
function viewCentre(cam, geom) {
  const cx = geom.canvasW / 2;
  const cy = geom.canvasH / 2;
  const ox = -cam.offsetX * geom.canvasW;
  const oy = -cam.offsetY * geom.canvasH;
  const cos = Math.cos(-cam.rotationRad);
  const sin = Math.sin(-cam.rotationRad);
  return {
    x: cx + (ox * cos - oy * sin) / cam.scale,
    y: cy + (ox * sin + oy * cos) / cam.scale
  };
}

function cameraFromCentre(centre, scale, rotationRad, geom) {
  const dx = centre.x - geom.canvasW / 2;
  const dy = centre.y - geom.canvasH / 2;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  return {
    scale,
    offsetX: (-scale * (dx * cos - dy * sin)) / geom.canvasW,
    offsetY: (-scale * (dx * sin + dy * cos)) / geom.canvasH,
    rotationRad
  };
}

/**
 * Clamp a camera so the viewport never leaves the image. Returns the corrected
 * camera plus `adjusted` (true when the request had to be changed).
 */
export function fitCameraToBounds(cam, geom) {
  const rotationRad = Number(cam.rotationRad) || 0;
  const minScale = minZoomForGeometry(geom, rotationRad);
  const scale = Math.max(Number(cam.scale) || 1, minScale);
  const { hx, hy } = viewHalfExtents(geom, rotationRad);
  const halfW = hx / scale;
  const halfH = hy / scale;

  const centre = viewCentre({ ...cam, scale, rotationRad }, geom);
  const eps = 1e-6;
  const minX = geom.destX + halfW;
  const maxX = geom.destX + geom.drawW - halfW;
  const minY = geom.destY + halfH;
  const maxY = geom.destY + geom.drawH - halfH;
  const fitted = {
    x: minX > maxX ? (minX + maxX) / 2 : clamp(centre.x, minX, maxX),
    y: minY > maxY ? (minY + maxY) / 2 : clamp(centre.y, minY, maxY)
  };

  const adjusted =
    scale - (Number(cam.scale) || 1) > eps ||
    Math.abs(fitted.x - centre.x) > 1e-3 ||
    Math.abs(fitted.y - centre.y) > 1e-3;

  return { ...cameraFromCentre(fitted, scale, rotationRad, geom), adjusted };
}

/**
 * Framing → camera. A framing says: image point (u, v) (normalised to the
 * source image) should appear at canvas position (anchorX, anchorY)
 * (normalised to the canvas) at zoom `zoom`.
 */
export function cameraFromFraming(framing, geom) {
  const scale = Number(framing.zoom) || 1;
  const rotationRad = ((Number(framing.rotateDeg) || 0) * Math.PI) / 180;
  const px = geom.destX + clamp01(framing.u ?? 0.5) * geom.drawW;
  const py = geom.destY + clamp01(framing.v ?? 0.5) * geom.drawH;
  const dx = px - geom.canvasW / 2;
  const dy = py - geom.canvasH / 2;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const ax = (framing.anchorX ?? 0.5) * geom.canvasW;
  const ay = (framing.anchorY ?? 0.5) * geom.canvasH;
  const cam = {
    scale,
    offsetX: (ax - geom.canvasW / 2 - scale * (dx * cos - dy * sin)) / geom.canvasW,
    offsetY: (ay - geom.canvasH / 2 - scale * (dx * sin + dy * cos)) / geom.canvasH,
    rotationRad
  };
  return fitCameraToBounds(cam, geom);
}

/** Canvas pixel position of an image-normalised point under a camera. */
export function projectImagePoint(u, v, cam, geom) {
  const px = geom.destX + u * geom.drawW - geom.canvasW / 2;
  const py = geom.destY + v * geom.drawH - geom.canvasH / 2;
  const cos = Math.cos(cam.rotationRad);
  const sin = Math.sin(cam.rotationRad);
  return {
    x: geom.canvasW / 2 + cam.offsetX * geom.canvasW + cam.scale * (px * cos - py * sin),
    y: geom.canvasH / 2 + cam.offsetY * geom.canvasH + cam.scale * (px * sin + py * cos)
  };
}

/** Canvas-normalised bounding box of an image-normalised box under a camera. */
export function projectImageBox(box, cam, geom) {
  const pts = [
    projectImagePoint(box.x0, box.y0, cam, geom),
    projectImagePoint(box.x1, box.y0, cam, geom),
    projectImagePoint(box.x0, box.y1, cam, geom),
    projectImagePoint(box.x1, box.y1, cam, geom)
  ];
  return {
    x0: Math.min(...pts.map((p) => p.x)) / geom.canvasW,
    y0: Math.min(...pts.map((p) => p.y)) / geom.canvasH,
    x1: Math.max(...pts.map((p) => p.x)) / geom.canvasW,
    y1: Math.max(...pts.map((p) => p.y)) / geom.canvasH
  };
}

/** Image-normalised position of a canvas-normalised point (inverse projection). */
export function unprojectCanvasPoint(nx, ny, cam, geom) {
  const qx = nx * geom.canvasW - geom.canvasW / 2 - cam.offsetX * geom.canvasW;
  const qy = ny * geom.canvasH - geom.canvasH / 2 - cam.offsetY * geom.canvasH;
  const cos = Math.cos(-cam.rotationRad);
  const sin = Math.sin(-cam.rotationRad);
  const px = (qx * cos - qy * sin) / cam.scale + geom.canvasW / 2;
  const py = (qx * sin + qy * cos) / cam.scale + geom.canvasH / 2;
  return { u: (px - geom.destX) / geom.drawW, v: (py - geom.destY) / geom.drawH };
}

/** Image-normalised bounding box of a canvas-normalised box (what the box covers in the source). */
export function unprojectCanvasBox(box, cam, geom) {
  const pts = [
    unprojectCanvasPoint(box.x0, box.y0, cam, geom),
    unprojectCanvasPoint(box.x1, box.y0, cam, geom),
    unprojectCanvasPoint(box.x0, box.y1, cam, geom),
    unprojectCanvasPoint(box.x1, box.y1, cam, geom)
  ];
  return {
    x0: Math.min(...pts.map((p) => p.u)),
    y0: Math.min(...pts.map((p) => p.v)),
    x1: Math.max(...pts.map((p) => p.u)),
    y1: Math.max(...pts.map((p) => p.v))
  };
}

export function boxArea(b) {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

export function intersectBoxes(a, b) {
  return {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1)
  };
}

/** Fraction of `box` (image space) that lands inside `safeArea` (canvas space) under `cam`. */
export function boxVisibility(box, cam, geom, safeArea = { x0: 0, y0: 0, x1: 1, y1: 1 }) {
  const projected = projectImageBox(box, cam, geom);
  const area = boxArea(projected);
  if (area <= 0) return 0;
  return boxArea(intersectBoxes(projected, safeArea)) / area;
}

/** Zoom at which `box` fills `fill` of the safe area (limited by the tighter axis). */
export function zoomToFillBox(box, fill, geom, safeArea) {
  const bw = Math.max(0.02, box.x1 - box.x0) * geom.drawW;
  const bh = Math.max(0.02, box.y1 - box.y0) * geom.drawH;
  const sw = (safeArea.x1 - safeArea.x0) * geom.canvasW;
  const sh = (safeArea.y1 - safeArea.y0) * geom.canvasH;
  return Math.min((sw * fill) / bw, (sh * fill) / bh);
}

function centreOf(box) {
  return { u: (box.x0 + box.x1) / 2, v: (box.y0 + box.y1) / 2 };
}

function boxAround(point, halfW, halfH) {
  return {
    x0: clamp01(point.x - halfW),
    y0: clamp01(point.y - halfH),
    x1: clamp01(point.x + halfW),
    y1: clamp01(point.y + halfH)
  };
}

/** Minimum share of the subject that must stay inside the safe area, per shot type. */
export const SUBJECT_VISIBILITY_FLOOR = {
  establishing: 0.9,
  'push-in': 0.82,
  reveal: 0.9, // applies to the END framing (the wide reveal)
  hold: 0.88,
  pan: 0.55,
  detail: 0 // a close-up deliberately crops the subject; its own target must stay visible instead
};

/**
 * Turn abstract shots ({ type, start, end, … }) into concrete, bounds-safe
 * framings. The subject box and detail point come from saliency analysis.
 *
 * Before a framing is accepted the planned camera is checked: the subject (or
 * the close-up target) must stay inside the caption-free safe area, otherwise
 * the zoom is backed off until it does.
 */
export function solveShotFramings(shots, {
  geom,
  saliency,
  safeArea = { x0: 0.06, y0: 0.07, x1: 0.94, y1: 0.68 },
  isVector = false,
  seed = 1,
  rotateDeg = 0,
  motionScale = 1
}) {
  const subject = saliency?.subjectBox || { x0: 0.25, y0: 0.22, x1: 0.75, y1: 0.68 };
  const focus = { x: saliency?.focusX ?? 0.5, y: saliency?.focusY ?? 0.45 };
  const detailPoint = saliency?.details?.[0] || focus;
  const subjectW = subject.x1 - subject.x0;
  const subjectH = subject.y1 - subject.y0;
  const detailBox = boxAround(detailPoint, Math.max(0.1, subjectW * 0.24), Math.max(0.08, subjectH * 0.24));

  const minZoom = minZoomForGeometry(geom);
  const maxZoom = maxZoomForGeometry(geom, { isVector });
  const anchor = { x: (safeArea.x0 + safeArea.x1) / 2, y: (safeArea.y0 + safeArea.y1) / 2 };
  const dir = seed % 2 === 0 ? -1 : 1;

  const frame = (box, fill, extra = {}) => ({
    u: centreOf(box).u,
    v: centreOf(box).v,
    zoom: clamp(zoomToFillBox(box, fill, geom, safeArea), minZoom, maxZoom),
    anchorX: anchor.x,
    anchorY: anchor.y,
    rotateDeg: 0,
    ...extra
  });

  const solved = [];
  let previousEndZoom = null;

  shots.forEach((shot, index) => {
    const travel = clamp((shot.motionScale ?? 1) * motionScale, 0.4, 1.6);
    // Agent-authored shots may pin explicit framings; they are still bounds-checked below.
    let from = shot.from ? { anchorX: anchor.x, anchorY: anchor.y, rotateDeg: 0, ...shot.from } : null;
    let to = shot.to ? { anchorX: anchor.x, anchorY: anchor.y, rotateDeg: 0, ...shot.to } : null;
    let visibilityTarget = subject;

    if (!from || !to) {
      const blendFocus = {
        x0: lerp(subject.x0, focus.x - subjectW / 2, 0.25),
        y0: lerp(subject.y0, focus.y - subjectH / 2, 0.25),
        x1: lerp(subject.x1, focus.x + subjectW / 2, 0.25),
        y1: lerp(subject.y1, focus.y + subjectH / 2, 0.25)
      };
      switch (shot.type) {
        case 'push-in':
          from = frame(subject, 0.74);
          to = frame(blendFocus, 0.74 + 0.22 * travel, { rotateDeg: rotateDeg * 0.5 });
          break;
        case 'reveal':
          from = frame(detailBox, 0.9);
          to = frame(subject, 0.84);
          break;
        case 'detail': {
          const drift = 0.035 * travel * dir;
          from = frame(detailBox, 0.8);
          from.u = clamp01(from.u - drift);
          to = frame(detailBox, 0.8 + 0.1 * travel);
          to.u = clamp01(to.u + drift);
          visibilityTarget = detailBox;
          break;
        }
        case 'pan': {
          const horizontal = subjectW * geom.drawW >= subjectH * geom.drawH * 0.8;
          const span = 0.2 * travel * dir;
          from = frame(subject, 1.18);
          to = frame(subject, 1.18);
          if (horizontal) {
            from.u = clamp01(centreOf(subject).u - subjectW * span);
            to.u = clamp01(centreOf(subject).u + subjectW * span);
          } else {
            from.v = clamp01(centreOf(subject).v + subjectH * span);
            to.v = clamp01(centreOf(subject).v - subjectH * span);
          }
          break;
        }
        case 'hold':
          from = frame(subject, 0.86);
          to = frame(subject, 0.86 + 0.035 * travel);
          break;
        case 'establishing':
        default:
          from = frame(subject, 0.8);
          to = frame(subject, 0.8 + 0.08 * travel);
          break;
      }
    }

    // A cut between two near-identical sizes reads as a glitch, not an edit:
    // make the incoming shot clearly tighter (or wider) than the outgoing one.
    if (index > 0 && previousEndZoom && !shot.from) {
      const ratio = from.zoom / previousEndZoom;
      if (ratio > 1 / 1.16 && ratio < 1.16) {
        const tighter = previousEndZoom * 1.24;
        const shift = tighter <= maxZoom ? tighter / from.zoom : previousEndZoom / 1.24 / from.zoom;
        from.zoom = clamp(from.zoom * shift, minZoom, maxZoom);
        to.zoom = clamp(to.zoom * shift, minZoom, maxZoom);
      }
    }

    // Repair hook: a shot can be told to frame wider/tighter (see quality-inspector repairs).
    if (Number.isFinite(shot.zoomScale) && shot.zoomScale > 0) {
      from.zoom = clamp(from.zoom * shot.zoomScale, minZoom, maxZoom);
      to.zoom = clamp(to.zoom * shot.zoomScale, minZoom, maxZoom);
    }

    // Safety pass: keep the visibility target inside the safe area for the whole move.
    const floor = SUBJECT_VISIBILITY_FLOOR[shot.type] ?? 0.8;
    const targetFloor = shot.type === 'detail' ? 0.9 : floor;
    const measure = (f) => boxVisibility(visibilityTarget, cameraFromFraming(f, geom), geom, safeArea);
    let adjustments = 0;
    const endpoints = shot.type === 'reveal' ? [to] : [from, to];
    for (const f of endpoints) {
      while (measure(f) < targetFloor && f.zoom > minZoom * 1.001 && adjustments < 24) {
        f.zoom = Math.max(minZoom, f.zoom * 0.94);
        adjustments++;
      }
    }

    const camFrom = cameraFromFraming(from, geom);
    const camTo = cameraFromFraming(to, geom);
    previousEndZoom = camTo.scale;
    // The most of the subject this image can ever show inside the safe area (widest
    // possible framing). A subject larger than the safe area is not a framing fault.
    const visibilityLimit = boxVisibility(subject, cameraFromFraming({ ...to, zoom: minZoom }, geom), geom, safeArea);

    solved.push({
      ...shot,
      from,
      to,
      camFrom,
      camTo,
      framingAdjustments: adjustments,
      visibilityLimit: Number(visibilityLimit.toFixed(3)),
      subjectVisibility: {
        start: Number(boxVisibility(subject, camFrom, geom, safeArea).toFixed(3)),
        end: Number(boxVisibility(subject, camTo, geom, safeArea).toFixed(3))
      },
      targetVisibility: {
        start: Number(boxVisibility(visibilityTarget, camFrom, geom, safeArea).toFixed(3)),
        end: Number(boxVisibility(visibilityTarget, camTo, geom, safeArea).toFixed(3))
      }
    });
  });

  return solved;
}

/**
 * Interpolate between two bounds-safe cameras. The view centre and 1/scale are
 * interpolated linearly: the set of valid (centre, 1/scale) pairs is convex, so
 * every intermediate camera is also inside the image — no per-frame clamping
 * kinks, which is what produces a perfectly smooth move.
 */
export function interpolateCamera(camA, camB, k, geom) {
  const cA = viewCentre(camA, geom);
  const cB = viewCentre(camB, geom);
  const inv = lerp(1 / camA.scale, 1 / camB.scale, k);
  const rotationRad = lerp(camA.rotationRad, camB.rotationRad, k);
  return cameraFromCentre({ x: lerp(cA.x, cB.x, k), y: lerp(cA.y, cB.y, k) }, 1 / inv, rotationRad, geom);
}

/** Smooth, deterministic low-frequency sway (never per-frame random → never jitters). */
function handheldSway(t, amount) {
  if (!(amount > 0)) return { x: 0, y: 0, r: 0 };
  return {
    x: (Math.sin(t * 0.9 + 1.2) * 0.0026 + Math.sin(t * 2.1) * 0.0009) * amount,
    y: (Math.cos(t * 0.7) * 0.0026 + Math.sin(t * 1.7 + 0.6) * 0.0009) * amount,
    r: Math.sin(t * 0.8 + 0.4) * 0.0012 * amount
  };
}

/** Raised-cosine bump centred on `centre` with half-width `half` (0 outside). */
function bump(t, centre, half) {
  const d = Math.abs(t - centre) / half;
  return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(d * Math.PI);
}

/**
 * Camera for a solved timeline at time `t`.
 * Returns { cam, shotIndex, local, blend } where `blend` is set during a
 * dissolve: { cam: outgoing camera, alpha: weight of the INCOMING shot }.
 */
export function evaluateTimelineCamera(solvedShots, t, geom, { handheld = 0, beats = [], beatPunch = 0 } = {}) {
  if (!solvedShots || solvedShots.length === 0) return null;

  let shotIndex = solvedShots.length - 1;
  for (let i = 0; i < solvedShots.length; i++) {
    if (t < solvedShots[i].end - 1e-9) {
      shotIndex = i;
      break;
    }
  }
  const shot = solvedShots[shotIndex];
  const span = Math.max(1e-3, shot.end - shot.start);
  const local = clamp01((t - shot.start) / span);

  const camAt = (s, time) => {
    const k = ease(s.easing, clamp01((time - s.start) / Math.max(1e-3, s.end - s.start)));
    return interpolateCamera(s.camFrom, s.camTo, k, geom);
  };

  let cam = camAt(shot, t);

  // Emphasis: a gentle, eased 1–2% push on the strongest beats (never a shake).
  if (beatPunch > 0 && beats.length) {
    let punch = 0;
    for (const b of beats) punch += (b.strength ?? 1) * bump(t, b.t + 0.12, 0.34);
    cam = { ...cam, scale: cam.scale * (1 + Math.min(1, punch) * beatPunch) };
  }

  const sway = handheldSway(t, typeof handheld === 'function' ? handheld(shot) : handheld);
  cam = fitCameraToBounds(
    { scale: cam.scale, offsetX: cam.offsetX + sway.x, offsetY: cam.offsetY + sway.y, rotationRad: cam.rotationRad + sway.r },
    geom
  );

  // Dissolve: the outgoing shot keeps moving underneath while the new one fades in.
  let blend = null;
  const tr = shot.transitionIn;
  if (shotIndex > 0 && tr && tr.type === 'dissolve' && tr.duration > 0) {
    const sinceCut = t - shot.start;
    if (sinceCut < tr.duration) {
      const prev = solvedShots[shotIndex - 1];
      // Carry the previous shot past its end at its final velocity so it does not visibly stop.
      const step = 1 / 30;
      const endCam = camAt(prev, prev.end);
      const beforeCam = camAt(prev, prev.end - step);
      const n = sinceCut / step;
      const prevCam = fitCameraToBounds({
        scale: endCam.scale + (endCam.scale - beforeCam.scale) * n,
        offsetX: endCam.offsetX + (endCam.offsetX - beforeCam.offsetX) * n,
        offsetY: endCam.offsetY + (endCam.offsetY - beforeCam.offsetY) * n,
        rotationRad: endCam.rotationRad
      }, geom);
      blend = { cam: prevCam, alpha: EASINGS['ease-in-out'](sinceCut / tr.duration) };
    }
  }

  return { cam, shotIndex, shot, local, blend };
}

/**
 * Per-frame camera path statistics, used by tests and the quality inspector to
 * prove motion is smooth: velocity/acceleration of the view centre in canvas
 * pixels per frame, ignoring the frames where a cut happens.
 */
export function measureCameraPath(sampleCam, { fps = 30, duration, geom, cutTimes = [] }) {
  const frames = Math.round(duration * fps);
  const centres = [];
  for (let i = 0; i < frames; i++) {
    const cam = sampleCam(i / fps);
    const c = viewCentre(cam, geom);
    centres.push({ x: c.x * cam.scale, y: c.y * cam.scale, s: cam.scale });
  }
  const cutFrames = new Set(cutTimes.map((c) => Math.round(c * fps)));
  let maxSpeed = 0;
  let maxAccel = 0;
  let maxScaleStep = 0;
  let borderViolations = 0;
  for (let i = 0; i < frames; i++) {
    const cam = sampleCam(i / fps);
    if (fitCameraToBounds(cam, geom).adjusted) borderViolations++;
    if (i === 0 || cutFrames.has(i)) continue;
    const v = Math.hypot(centres[i].x - centres[i - 1].x, centres[i].y - centres[i - 1].y);
    maxSpeed = Math.max(maxSpeed, v);
    maxScaleStep = Math.max(maxScaleStep, Math.abs(centres[i].s - centres[i - 1].s));
    if (i >= 2 && !cutFrames.has(i - 1)) {
      const ax = centres[i].x - 2 * centres[i - 1].x + centres[i - 2].x;
      const ay = centres[i].y - 2 * centres[i - 1].y + centres[i - 2].y;
      maxAccel = Math.max(maxAccel, Math.hypot(ax, ay));
    }
  }
  return { frames, maxSpeed, maxAccel, maxScaleStep, borderViolations };
}
