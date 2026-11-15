import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSaliencyFromPixels, buildScenePlan, parsePromptDirectives, generateModelCustomCanvasCode, INHOUSE_MODELS } from '../../src/models/inhouse-models.js';
import { prepareScene, renderFrameAtTime } from '../../src/engine/renderer.js';
import { fitCameraToBounds } from '../../src/engine/camera.js';
import { planCharacterPlacement, characterBodyBox, getCharacterPose } from '../../src/engine/character.js';
import { renderPresetEffects, renderFilmGrade, resolveEffectIntensity, FACT_PRESETS, smoothNoise } from '../../src/presets/fact-presets.js';
import { planRenderSegments, stableStringify, hashString } from '../../src/engine/exporter.js';
import { createMockContext, maxAlpha, makeImage } from '../helpers.js';

const SUBTITLE = 'The Great Pyramid of Giza aligns with true north within 3/60th of a single degree.';

test('saliency: finds an off-centre subject and boxes it', () => {
  const data = makeImage(96, 96, (x, y) => (x >= 52 && x < 82 && y >= 40 && y < 74 ? [230, 180, 60] : [20 + y * 0.4, 20, 44 + y * 0.3]));
  const a = analyzeSaliencyFromPixels(data, 96, 96);
  assert.equal(a.analysed, true);
  assert.ok(a.focusX > 0.58 && a.focusX < 0.8, `focusX ${a.focusX}`);
  assert.ok(a.focusY > 0.45 && a.focusY < 0.7, `focusY ${a.focusY}`);
  // The true subject (0.54–0.85 × 0.42–0.77) must be inside the box, and the box must not be the whole frame.
  assert.ok(a.subjectBox.x0 <= 0.56 && a.subjectBox.x1 >= 0.83 && a.subjectBox.y0 <= 0.44 && a.subjectBox.y1 >= 0.75);
  assert.ok((a.subjectBox.x1 - a.subjectBox.x0) * (a.subjectBox.y1 - a.subjectBox.y0) < 0.45);
  assert.ok(a.confidence > 0.5);
  assert.ok(a.details.length >= 1);
});

test('saliency: a flat image yields a safe centred fallback, not garbage', () => {
  const a = analyzeSaliencyFromPixels(makeImage(64, 64, () => [80, 80, 80]), 64, 64);
  assert.ok(a.subjectBox.x0 < 0.5 && a.subjectBox.x1 > 0.5);
  assert.equal(a.confidence, 0);
  const empty = analyzeSaliencyFromPixels(null, 0, 0);
  assert.equal(empty.analysed, false);
});

test('scene plans carry a timeline and stay loadable as plain JSON', () => {
  for (const model of INHOUSE_MODELS) {
    const plan = buildScenePlan({ img: null, modelId: model.id, duration: 4, factTitle: 'DID YOU KNOW?', factSubtitle: SUBTITLE, autoSelectPreset: true });
    assert.equal(plan.schemaVersion, '2.0');
    assert.equal(plan.cameraMode, 'director');
    assert.ok(plan.timeline.shots.length >= 1);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, 'plan is pure JSON');
    // Existing fields older tools rely on are still there.
    for (const key of ['modelId', 'presetId', 'zoomStart', 'zoomEnd', 'panX', 'panY', 'rotateDeg', 'focusX', 'focusY', 'factTitle', 'factSubtitle', 'generatedCustomCode', 'totalFrames']) {
      assert.ok(key in plan, `plan.${key}`);
    }
  }
});

test('generated effect code compiles and never uses additive blending or a hard-edged flare box', () => {
  for (const model of INHOUSE_MODELS) {
    for (const directives of [{}, { hasRain: true }, { hasEmbers: true }]) {
      const code = generateModelCustomCanvasCode({ modelId: model.id, promptDirectives: directives });
      assert.doesNotThrow(() => new Function('ctx', 'params', code));
      assert.ok(!/lighter/.test(code), `${model.id}: no additive blend mode`);
    }
  }
  const flare = generateModelCustomCanvasCode({ modelId: 'saliency-vision' });
  assert.ok(!/fillRect/.test(flare), 'the focal glow is an ellipse that fades out, not a filled rectangle');
});

test('prompt direction maps to camera hints', () => {
  assert.equal(parsePromptDirectives('slow pull back reveal').motionHint.type, 'reveal');
  assert.equal(parsePromptDirectives('pan left across the scene').motionHint.type, 'pan');
  assert.equal(parsePromptDirectives('dramatic').motionHint.type, 'push-in');
  assert.equal(parsePromptDirectives('').motionHint, undefined);
});

test('prepareScene: director plan → solved shots, captions clear of the subject area, presenter placed', () => {
  const plan = buildScenePlan({ img: null, duration: 4, factTitle: 'DID YOU KNOW?', factSubtitle: SUBTITLE });
  const rt = prepareScene({ duration: 4, scenePlan: plan, probe: false });
  assert.equal(rt.mode, 'director');
  assert.equal(rt.shots.length, plan.timeline.shots.length);
  for (const shot of rt.shots) {
    assert.ok(shot.camFrom && shot.camTo);
    assert.equal(fitCameraToBounds(shot.camFrom, rt.geom).adjusted, false, 'solved cameras are inside the image');
    assert.equal(fitCameraToBounds(shot.camTo, rt.geom).adjusted, false);
  }
  assert.ok(rt.safeArea.y1 < rt.captionLayout.band.y0, 'the subject safe area ends above the caption block');
  assert.equal(rt.captionLayout.withinSafeZone, true);
  assert.ok(rt.character.standX < 0.3 || rt.character.standX > 0.7, 'presenter stands at the side');
  assert.ok(rt.character.feetYFrac < rt.captionLayout.band.y0, 'presenter stands above the captions');
});

test('backwards compatibility: a schema 1.0 plan (no cameraMode/timeline) still renders as one manual move', () => {
  const legacy = {
    schemaVersion: '1.0', modelId: 'viral-hook-v1', presetId: '3d-perspective-tilt', duration: 4,
    focusX: 0.5, focusY: 0.42, zoomStart: 1.02, zoomEnd: 1.28, panX: 0.018, panY: -0.005, rotateDeg: -1.06,
    particleCount: 80, vignetteStrength: 0.84, factTitle: 'DID YOU KNOW?', factSubtitle: SUBTITLE
  };
  const rt = prepareScene({ duration: 4, presetId: legacy.presetId, scenePlan: legacy, probe: false });
  assert.equal(rt.mode, 'manual');
  assert.equal(rt.shots.length, 1);
  const start = rt.cameraAt(0).cam;
  const end = rt.cameraAt(3.9).cam;
  assert.ok(end.scale > start.scale, 'the plan\'s zoom-in is honoured');
  assert.ok(Math.abs(start.scale - 1.02) < 0.01);
});

test('the timeline is re-planned when the caption text or duration no longer matches the plan', () => {
  const plan = buildScenePlan({ img: null, duration: 4, factSubtitle: SUBTITLE });
  const same = prepareScene({ duration: 4, scenePlan: plan, factSubtitle: SUBTITLE, probe: false });
  assert.equal(same.timeline, plan.timeline, 'unchanged text reuses the stored timeline');
  const changed = prepareScene({ duration: 4, scenePlan: plan, factSubtitle: 'Totally different words here.', probe: false });
  assert.notEqual(changed.timeline, plan.timeline);
  assert.equal(changed.timeline.cues.map((c) => c.text).join(' '), 'Totally different words here.');
});

test('renderFrameAtTime draws every layer without a real canvas and never switches to additive blending', () => {
  for (const preset of FACT_PRESETS) {
    const plan = buildScenePlan({ img: null, presetId: preset.id, duration: 3, factTitle: 'DID YOU KNOW?', factSubtitle: SUBTITLE });
    const { ctx, log } = createMockContext(1080, 1920);
    const custom = new Function('ctx', 'params', plan.generatedCustomCode);
    for (const t of [0, 0.5, 1.5, 2.9]) {
      const info = renderFrameAtTime(ctx, { img: null, t, duration: 3, presetId: preset.id, factTitle: plan.factTitle, factSubtitle: plan.factSubtitle, scenePlan: plan, customDrawFn: custom });
      assert.equal(info.totalFrames, 90);
      assert.equal(info.width, 1080);
    }
    assert.ok(!log.compositeOps.includes('lighter'), `${preset.id}: no additive blending anywhere in the frame`);
    assert.ok(log.texts.length > 0, 'captions were drawn');
  }
});

test('a custom snippet that throws does not break the frame and is reported', () => {
  const plan = buildScenePlan({ img: null, duration: 3, factSubtitle: SUBTITLE });
  const rt = prepareScene({ duration: 3, scenePlan: plan, probe: false });
  const { ctx, log } = createMockContext();
  const bad = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => renderFrameAtTime(ctx, { img: null, t: 1, duration: 3, scenePlan: plan, customDrawFn: bad, runtime: rt }));
  assert.equal(rt.customCodeError, 'boom');
  assert.ok(log.texts.length > 0, 'captions still drawn after the snippet failed');
});

test('effects: brightness is bounded — no light effect paints more than a faint tint, at any intensity', () => {
  for (const preset of FACT_PRESETS) {
    for (const intensity of [1, 1.5]) {
      const { ctx, log } = createMockContext();
      for (const t of [0, 0.7, 1.4, 2.1, 2.8]) {
        renderPresetEffects(ctx, {
          presetId: preset.id, t, duration: 3, width: 1080, height: 1920, scenePlan: { ...preset.defaults }, intensity,
          cam: { scale: 1.1, offsetX: 0.01, offsetY: 0, rotationRad: 0 }, subject: { x0: 0.3, y0: 0.25, x1: 0.7, y1: 0.6 },
          beats: [{ t: 1.4, strength: 1 }], drawCoverImage: () => {}
        });
      }
      const light = [...log.colorStops.map((c) => c.color), ...log.fillStyles].filter((c) => {
        const m = String(c).match(/rgba\((\d+),\s*(\d+),\s*(\d+)/);
        return m && Number(m[1]) + Number(m[2]) + Number(m[3]) > 450; // bright colours only
      });
      assert.ok(maxAlpha(light) <= 0.62, `${preset.id} @ ${intensity}: brightest light alpha ${maxAlpha(light)}`);
      // Full-frame washes (gradients) stay far below wash-out strength.
      const washes = log.colorStops.map((c) => c.color).filter((c) => /rgba\((2\d\d),/.test(c));
      assert.ok(maxAlpha(washes) <= 0.52, `${preset.id} @ ${intensity}: gradient alpha ${maxAlpha(washes)}`);
      assert.ok(!log.compositeOps.includes('lighter'));
    }
  }
});

test('effect intensity 0 draws nothing; out-of-range values are clamped', () => {
  const { ctx, log } = createMockContext();
  renderPresetEffects(ctx, { presetId: 'documentary-kenburns', t: 1, duration: 3, width: 1080, height: 1920, scenePlan: {}, intensity: 0 });
  assert.equal(log.calls.length, 0);
  assert.equal(resolveEffectIntensity({ effectIntensity: 9 }), 1.5);
  assert.equal(resolveEffectIntensity({ effectIntensity: -1 }), 0);
  assert.equal(resolveEffectIntensity({}), 1);
  assert.equal(resolveEffectIntensity({ effectIntensity: 'x' }), 1);
});

test('film grade is a subtle soft-light tint and restores the blend mode', () => {
  const { ctx, log } = createMockContext();
  renderFilmGrade(ctx, { width: 1080, height: 1920, warmth: 0.22 });
  assert.deepEqual(log.compositeOps, ['soft-light']);
  assert.ok(maxAlpha(log.fillStyles) < 0.2);
});

test('smooth noise is continuous (no frame-to-frame jumps) and deterministic', () => {
  let maxStep = 0;
  for (let i = 1; i < 300; i++) maxStep = Math.max(maxStep, Math.abs(smoothNoise(i / 30 * 5, 3) - smoothNoise((i - 1) / 30 * 5, 3)));
  assert.ok(maxStep < 0.6, `largest step ${maxStep}`);
  assert.equal(smoothNoise(1.37, 9), smoothNoise(1.37, 9));
});

test('presenter placement: stands beside the subject, shrinks before it covers it', () => {
  const narrow = planCharacterPlacement({ subjectBoxes: [{ x0: 0.35, y0: 0.2, x1: 0.65, y1: 0.62 }], captionTop: 0.7 });
  assert.equal(narrow.acceptable, true);
  assert.equal(narrow.heightFrac, 0.33, 'full size when there is room');
  assert.equal(narrow.occlusion, 0);

  const wide = planCharacterPlacement({ subjectBoxes: [{ x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.62 }], captionTop: 0.7 });
  assert.equal(wide.acceptable, true);
  assert.ok(wide.heightFrac < 0.33, 'smaller when the subject is wide');
  assert.ok(wide.occlusion <= 0.1);

  // The camera pans: the subject sits at the left edge in one sample and the right edge in another.
  const nowhere = planCharacterPlacement({
    subjectBoxes: [{ x0: 0, y0: 0.4, x1: 0.3, y1: 0.68 }, { x0: 0.7, y0: 0.4, x1: 1, y1: 0.68 }],
    captionTop: 0.7
  });
  assert.equal(nowhere.acceptable, false, 'no acceptable spot is reported, not hidden');
  assert.ok(nowhere.occlusion > 0.1);

  const right = planCharacterPlacement({ subjectBoxes: [{ x0: 0.05, y0: 0.2, x1: 0.6, y1: 0.62 }], captionTop: 0.7 });
  assert.equal(right.side, 'right', 'picks the side with free space');

  const body = characterBodyBox({ ...narrow, width: 1080, height: 1920 });
  assert.ok(body.y1 <= 0.7, 'feet above the captions');
  const pose = getCharacterPose(2, { duration: 4, standX: narrow.standX, heightFrac: narrow.heightFrac, feetYFrac: narrow.feetYFrac });
  assert.ok(Math.abs(pose.anchorX / 1080 - narrow.standX) < 0.02, 'pose honours the planned standing spot');
});

test('render segments: one per shot, covering every frame exactly once', () => {
  const plan = buildScenePlan({ img: null, duration: 5, modelId: 'viral-hook-v1', factSubtitle: 'Nobody knows how it was built. But the Great Pyramid aligns with true north almost perfectly!' });
  const rt = prepareScene({ duration: 5, scenePlan: plan, probe: false });
  const segs = planRenderSegments(rt, {});
  assert.equal(segs.length, rt.shots.length);
  assert.equal(segs[0].startFrame, 0);
  assert.equal(segs.at(-1).endFrame, 150);
  segs.forEach((s, i) => {
    assert.equal(s.frames, s.endFrame - s.startFrame);
    if (i > 0) assert.equal(s.startFrame, segs[i - 1].endFrame);
  });
});

test('cache correctness: a per-shot change invalidates only that shot; a global change invalidates all', () => {
  const plan = buildScenePlan({ img: null, duration: 5, modelId: 'viral-hook-v1', factSubtitle: 'Nobody knows how it was built. But the Great Pyramid aligns with true north almost perfectly!' });
  const sign = (p, extra = {}) => planRenderSegments(prepareScene({ duration: 5, scenePlan: p, probe: false }), extra).map((s) => s.signature);
  const base = sign(plan);
  assert.deepEqual(sign(JSON.parse(JSON.stringify(plan))), base, 'an identical plan gives identical signatures');

  const lastId = plan.timeline.shots.at(-1).id;
  const oneShot = sign({ ...plan, shotOverrides: { [lastId]: { fxGain: 0.5 } } });
  assert.equal(oneShot.length, base.length);
  oneShot.forEach((sig, i) => {
    if (i === base.length - 1) assert.notEqual(sig, base[i], 'the repaired shot is re-rendered');
    else assert.equal(sig, base[i], `shot ${i + 1} is reused from cache`);
  });

  const global = sign({ ...plan, titleColor: '#ff0000' });
  global.forEach((sig, i) => assert.notEqual(sig, base[i], 'a caption colour change affects every shot'));

  const quality = sign(plan, { quality: 'cinematic' });
  quality.forEach((sig, i) => assert.notEqual(sig, base[i], 'a different render quality never reuses fast-quality frames'));

  const bookkeeping = sign({ ...plan, repairHistory: { x: 1 }, motionPrompt: 'changed note' });
  assert.deepEqual(bookkeeping, base, 'non-visual fields do not invalidate the cache');
});

test('stableStringify and hashString are order-independent and deterministic', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(stableStringify({ f: () => 1, u: undefined, n: NaN }), '{"n":null}');
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});
