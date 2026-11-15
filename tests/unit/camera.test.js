import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EASINGS,
  computeCoverGeometry,
  fitCameraToBounds,
  cameraFromFraming,
  projectImagePoint,
  unprojectCanvasPoint,
  interpolateCamera,
  solveShotFramings,
  evaluateTimelineCamera,
  measureCameraPath,
  minZoomForGeometry,
  boxVisibility,
  SUBJECT_VISIBILITY_FLOOR
} from '../../src/engine/camera.js';
import { computeCameraTransform, FACT_PRESETS } from '../../src/presets/fact-presets.js';
import { planShots } from '../../src/engine/director.js';

const geom = computeCoverGeometry({ imgW: 1080, imgH: 1920, canvasW: 1080, canvasH: 1920 });
const wideGeom = computeCoverGeometry({ imgW: 4000, imgH: 2250, canvasW: 1080, canvasH: 1920 });
const saliency = { focusX: 0.5, focusY: 0.45, subjectBox: { x0: 0.3, y0: 0.25, x1: 0.7, y1: 0.6 }, details: [{ x: 0.5, y: 0.3, strength: 1 }] };
const safeArea = { x0: 0.06, y0: 0.07, x1: 0.94, y1: 0.68 };

test('easing curves: start at 0, end at 1, never go backwards', () => {
  for (const [name, fn] of Object.entries(EASINGS)) {
    assert.ok(Math.abs(fn(0)) < 1e-9, `${name}(0)`);
    assert.ok(Math.abs(fn(1) - 1) < 1e-9, `${name}(1)`);
    let prev = 0;
    for (let i = 1; i <= 200; i++) {
      const v = fn(i / 200);
      assert.ok(v >= prev - 1e-9, `${name} is monotonic at ${i / 200}`);
      prev = v;
    }
  }
});

test('ease-in-out has no velocity jump at either end (smooth start and stop)', () => {
  const fn = EASINGS['ease-in-out'];
  assert.ok(fn(0.01) < 0.0002);
  assert.ok(1 - fn(0.99) < 0.0002);
});

test('fitCameraToBounds: the view can never leave the image', () => {
  const requests = [
    { scale: 0.5, offsetX: 0, offsetY: 0, rotationRad: 0 },
    { scale: 1, offsetX: 0.4, offsetY: -0.4, rotationRad: 0 },
    { scale: 1.2, offsetX: -0.5, offsetY: 0.6, rotationRad: 0.03 },
    { scale: 1.05, offsetX: 0.06, offsetY: 0.05, rotationRad: -0.02 }
  ];
  for (const req of requests) {
    const cam = fitCameraToBounds(req, geom);
    // Every canvas corner must map inside the image.
    for (const [nx, ny] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const p = unprojectCanvasPoint(nx, ny, cam, geom);
      assert.ok(p.u >= -1e-6 && p.u <= 1 + 1e-6 && p.v >= -1e-6 && p.v <= 1 + 1e-6, `corner ${nx},${ny} → ${p.u.toFixed(4)},${p.v.toFixed(4)}`);
    }
    assert.equal(fitCameraToBounds(cam, geom).adjusted, false, 'a fitted camera is stable');
  }
});

test('cameraFromFraming puts the requested image point at the requested screen anchor', () => {
  const cam = cameraFromFraming({ u: 0.5, v: 0.5, zoom: 1.3, anchorX: 0.5, anchorY: 0.4 }, geom);
  const p = projectImagePoint(0.5, 0.5, cam, geom);
  assert.ok(Math.abs(p.x / 1080 - 0.5) < 1e-6);
  assert.ok(Math.abs(p.y / 1920 - 0.4) < 1e-6);
});

test('projection and inverse projection round-trip', () => {
  const cam = cameraFromFraming({ u: 0.4, v: 0.55, zoom: 1.4, rotateDeg: 1 }, geom);
  const p = projectImagePoint(0.37, 0.61, cam, geom);
  const back = unprojectCanvasPoint(p.x / 1080, p.y / 1920, cam, geom);
  assert.ok(Math.abs(back.u - 0.37) < 1e-9 && Math.abs(back.v - 0.61) < 1e-9);
});

test('interpolating between two valid cameras never leaves the image', () => {
  const a = cameraFromFraming({ u: 0.1, v: 0.1, zoom: 1.6 }, wideGeom);
  const b = cameraFromFraming({ u: 0.9, v: 0.9, zoom: minZoomForGeometry(wideGeom) }, wideGeom);
  for (let i = 0; i <= 50; i++) {
    const cam = interpolateCamera(a, b, i / 50, wideGeom);
    assert.equal(fitCameraToBounds(cam, wideGeom).adjusted, false, `k=${i / 50}`);
  }
});

test('solved framings keep the subject inside the caption-free safe area', () => {
  for (const modelId of ['saliency-vision', 'viral-hook-v1', 'cinematic-doc-v1', 'mystery-noir-v1', 'scifi-neural-v1']) {
    for (const duration of [3, 4, 5]) {
      const { shots } = planShots({ duration, modelId });
      const solved = solveShotFramings(shots, { geom, saliency, safeArea, isVector: true });
      for (const shot of solved) {
        const floor = SUBJECT_VISIBILITY_FLOOR[shot.type];
        if (shot.type === 'detail') {
          assert.ok(Math.min(shot.targetVisibility.start, shot.targetVisibility.end) >= 0.85, `${modelId} ${shot.id} close-up target visible`);
        } else if (shot.type === 'reveal') {
          assert.ok(shot.subjectVisibility.end >= floor - 0.02, `${modelId} ${shot.id} reveal ends on the whole subject`);
        } else {
          assert.ok(Math.min(shot.subjectVisibility.start, shot.subjectVisibility.end) >= floor - 0.02, `${modelId} ${shot.id} (${shot.type}) subject visible`);
        }
      }
    }
  }
});

test('timeline camera: smooth inside every shot, no black borders, cuts only where planned', () => {
  for (const modelId of ['saliency-vision', 'viral-hook-v1', 'cinematic-doc-v1', 'mystery-noir-v1', 'scifi-neural-v1']) {
    const duration = 5;
    const { shots, style } = planShots({ duration, modelId });
    const solved = solveShotFramings(shots, { geom, saliency, safeArea, isVector: true });
    const sample = (t) => evaluateTimelineCamera(solved, t, geom, { handheld: style.handheld, beatPunch: style.beatPunch, beats: [{ t: 1.2, strength: 1 }] }).cam;
    const path = measureCameraPath(sample, { duration, geom, cutTimes: solved.slice(1).map((s) => s.start) });
    assert.equal(path.borderViolations, 0, `${modelId}: view stays inside the image`);
    // Acceleration well under 1.2% of frame width per frame² — no jerks, no shake.
    assert.ok(path.maxAccel < 1080 * 0.012, `${modelId}: max acceleration ${path.maxAccel.toFixed(2)} px/frame²`);
    assert.ok(path.maxSpeed < 40, `${modelId}: max speed ${path.maxSpeed.toFixed(1)} px/frame`);
  }
});

test('consecutive shots differ clearly in size, so a cut never looks like a glitch', () => {
  const { shots } = planShots({ duration: 5, modelId: 'saliency-vision' });
  const solved = solveShotFramings(shots, { geom: wideGeom, saliency, safeArea, isVector: true });
  for (let i = 1; i < solved.length; i++) {
    const ratio = solved[i].camFrom.scale / solved[i - 1].camTo.scale;
    assert.ok(ratio >= 1.15 || ratio <= 1 / 1.15, `cut ${i}: scale ratio ${ratio.toFixed(3)}`);
  }
});

test('manual (legacy) camera: clamped to the image and free of per-frame jitter', () => {
  for (const preset of FACT_PRESETS) {
    const plan = { ...preset.defaults };
    const sample = (t) => computeCameraTransform(t, 4, preset.id, plan, geom);
    const path = measureCameraPath(sample, { duration: 4, geom });
    assert.equal(path.borderViolations, 0, `${preset.id}: no black borders`);
    assert.ok(path.maxAccel < 3, `${preset.id}: acceleration ${path.maxAccel.toFixed(2)} px/frame² (no shake)`);
  }
});

test('legacy camera without geometry keeps its original return shape', () => {
  const cam = computeCameraTransform(1, 4, 'documentary-kenburns', { zoomStart: 1, zoomEnd: 1.3, panX: -0.06, panY: -0.05, rotateDeg: 0.8 });
  for (const key of ['scale', 'offsetX', 'offsetY', 'rotationRad', 'progress', 'eased']) assert.equal(typeof cam[key], 'number');
  assert.ok(cam.scale > 1 && cam.scale < 1.3);
});

test('boxVisibility measures how much of a box is inside the safe area', () => {
  const cam = cameraFromFraming({ u: 0.5, v: 0.5, zoom: 1, anchorX: 0.5, anchorY: 0.5 }, geom);
  assert.ok(boxVisibility({ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }, cam, geom) > 0.99);
  assert.ok(boxVisibility({ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }, cam, geom, { x0: 0, y0: 0, x1: 1, y1: 0.5 }) < 0.6);
});
