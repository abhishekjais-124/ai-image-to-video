import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFrameStats,
  lumaPlane,
  meanAbsDiff,
  structureCorrelation,
  changedFraction,
  measureEffectExcess,
  contrastRatio,
  relativeLuminance,
  DEFAULT_EXPOSURE_LIMITS
} from '../../src/engine/frame-metrics.js';
import {
  analyzeFrameSeries,
  evaluateScenePlan,
  buildQualityReport,
  proposeRepairs,
  scoreIssues,
  isBetterReport,
  findRuns,
  listIssues,
  MAX_REPAIRS_PER_ISSUE
} from '../../src/engine/quality-inspector.js';
import { buildScenePlan } from '../../src/models/inhouse-models.js';
import { prepareScene } from '../../src/engine/renderer.js';
import { makeImage } from '../helpers.js';

const frame = (over = {}) => ({ meanLuma: 60, stdLuma: 40, clipFrac: 0.005, satHighFrac: 0.02, diffPrev: 0.8, ...over });
const steady = (n, over = {}) => Array.from({ length: n }, () => frame(over));
const codes = (issues) => issues.map((i) => i.code);

test('frame stats: luma, clipping and box restriction', () => {
  const data = makeImage(40, 40, (x) => (x < 20 ? [255, 255, 255] : [0, 0, 0]));
  const all = computeFrameStats(data, 40, 40);
  assert.ok(Math.abs(all.meanLuma - 127.5) < 1);
  assert.ok(Math.abs(all.clipFrac - 0.5) < 0.01);
  const left = computeFrameStats(data, 40, 40, { box: { x0: 0, y0: 0, x1: 0.5, y1: 1 } });
  assert.ok(left.clipFrac > 0.99);
  assert.equal(left.lumaP90, 255);
});

test('structure correlation: a brighter copy still matches; a washed-out or covered subject does not', () => {
  const w = 32, h = 32;
  const base = lumaPlane(makeImage(w, h, (x, y) => [x * 6, x * 6, y * 3]), w, h);
  const brighter = base.map((v) => Math.min(255, v + 25));
  const washed = base.map(() => 250);
  assert.ok(structureCorrelation(base, brighter, w, h) > 0.97);
  assert.ok(structureCorrelation(base, washed, w, h) < 0.1);
  assert.ok(changedFraction(base, washed, w, h) > 0.6);
  assert.equal(meanAbsDiff(base, base), 0);

  // A small bright overlay on a dark, low-contrast subject is "covered", not "washed out".
  const dark = lumaPlane(makeImage(w, h, (x, y) => [20 + (x % 4), 20 + (y % 4), 22]), w, h);
  const withOverlay = Float32Array.from(dark);
  for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) withOverlay[y * w + x] = 220;
  assert.ok(structureCorrelation(dark, withOverlay, w, h, null, { ignoreAbove: 48 }) > 0.9);
  assert.ok(changedFraction(dark, withOverlay, w, h) > 0.03);
});

test('exposure guard maths: effects inside the limits pass, a wash-out is quantified', () => {
  const base = { meanLuma: 40, stdLuma: 30, clipFrac: 0.01 };
  const subtle = measureEffectExcess(base, { meanLuma: 46, stdLuma: 30, clipFrac: 0.012 }, base, { meanLuma: 45, stdLuma: 29 });
  assert.ok(subtle.ratio <= 1);
  const heavy = measureEffectExcess(base, { meanLuma: 120, stdLuma: 12, clipFrac: 0.3 }, base, { meanLuma: 130, stdLuma: 8 });
  assert.ok(heavy.ratio > 4, `ratio ${heavy.ratio}`);
  // Dividing the effect opacity by the ratio brings a linear effect back inside the limit.
  const gain = 1 / heavy.ratio;
  assert.ok((120 - 40) * gain <= DEFAULT_EXPOSURE_LIMITS.maxLumaGain + 1e-9);
  // Darkening is limited too.
  assert.ok(measureEffectExcess(base, { meanLuma: -20 + 40 - 40, stdLuma: 30, clipFrac: 0 }, null, null).ratio > 1);
});

test('contrast ratio: white text on black is 21:1, on a bright background it fails 4.5:1', () => {
  assert.ok(Math.abs(contrastRatio(1, 0) - 21) < 1e-9);
  assert.ok(contrastRatio(1, relativeLuminance(230)) < 4.5);
  assert.ok(contrastRatio(1, relativeLuminance(60)) > 4.5);
});

test('findRuns groups consecutive flags', () => {
  assert.deepEqual(findRuns([false, true, true, false, true], 2), [[1, 2]]);
  assert.deepEqual(findRuns([true, true, true], 1), [[0, 2]]);
});

test('regression: the progressive white-out of the broken pyramid sample is detected as overexposure', () => {
  // Shape of the real "before" file: mean luma 23 → 254 and >90% of the frame near white.
  const frames = Array.from({ length: 60 }, (_, i) => {
    const k = Math.min(1, i / 30);
    return frame({ meanLuma: 23 + 231 * k, clipFrac: 0.92 * k, diffPrev: i < 30 ? 6 : 0.3 });
  });
  const issues = analyzeFrameSeries(frames);
  const over = issues.find((i) => i.code === 'overexposure');
  assert.ok(over, 'overexposure reported');
  assert.equal(over.severity, 'error');
  assert.ok(over.frames[1] - over.frames[0] > 20, 'reported as a sustained run');
  assert.equal(over.repairable, true);
});

test('a clean, steadily moving clip raises no issues', () => {
  assert.deepEqual(analyzeFrameSeries(steady(90)), []);
});

test('a one-frame brightness flash is caught; the same step at a planned cut is not', () => {
  const frames = steady(60);
  frames[30] = frame({ meanLuma: 100 });
  assert.ok(codes(analyzeFrameSeries(frames)).includes('brightness-flash'));
  const cut = steady(60).map((f, i) => (i >= 30 ? frame({ meanLuma: 100, diffPrev: i === 30 ? 30 : 0.8 }) : f));
  assert.ok(!codes(analyzeFrameSeries(cut, { cutFrames: [30] })).includes('brightness-flash'));
});

test('a frozen picture is caught (and normal slow motion is not)', () => {
  const frames = steady(90).map((f, i) => (i >= 20 && i < 60 ? frame({ diffPrev: 0.01 }) : f));
  const frozen = analyzeFrameSeries(frames).find((i) => i.code === 'frozen');
  assert.ok(frozen);
  assert.deepEqual(frozen.frames, [20, 59]);
  assert.ok(!codes(analyzeFrameSeries(steady(90, { diffPrev: 0.15 }))).includes('frozen'));
});

test('alternating (jittery) motion is caught; smooth easing is not', () => {
  const jitter = Array.from({ length: 60 }, (_, i) => frame({ diffPrev: i % 2 ? 2.4 : 0.6 }));
  assert.ok(codes(analyzeFrameSeries(jitter)).includes('motion-jitter'));
  const eased = Array.from({ length: 60 }, (_, i) => frame({ diffPrev: 0.5 + Math.sin((i / 60) * Math.PI) * 1.5 }));
  assert.ok(!codes(analyzeFrameSeries(eased)).includes('motion-jitter'));
});

test('a blank frame between normal frames is an objective error', () => {
  const frames = steady(40);
  frames[17] = frame({ stdLuma: 0.2, meanLuma: 128, diffPrev: 60 });
  const blank = analyzeFrameSeries(frames).find((i) => i.code === 'blank-frame');
  assert.ok(blank);
  assert.equal(blank.kind, 'objective');
  assert.equal(blank.severity, 'error');
});

test('with clean-plate references: effect wash-out and a hidden subject are measured against the source', () => {
  const frames = steady(60, { meanLuma: 200, clipFrac: 0.4 });
  // A naturally bright image with no gain over its clean plate is NOT a wash-out.
  const natural = frames.map((_, i) => (i % 3 === 0 ? { lumaGain: 2, clipGain: 0.004, satGain: 0, subjectCorrelation: 0.97, subjectChanged: 0.01 } : null));
  assert.deepEqual(analyzeFrameSeries(frames, { references: natural }), []);

  const washed = frames.map((_, i) => (i % 3 === 0 ? { lumaGain: i >= 20 ? 80 : 2, clipGain: i >= 20 ? 0.3 : 0, satGain: 0, subjectCorrelation: i >= 20 ? 0.2 : 0.97, subjectChanged: i >= 20 ? 0.7 : 0.01 } : null));
  const found = codes(analyzeFrameSeries(frames, { references: washed }));
  assert.ok(found.includes('overexposure'));
  assert.ok(found.includes('subject-obscured'));

  const covered = frames.map((_, i) => (i % 3 === 0 ? { lumaGain: 3, clipGain: 0, satGain: 0, subjectCorrelation: 0.95, subjectChanged: 0.3 } : null));
  assert.deepEqual(codes(analyzeFrameSeries(frames, { references: covered })), ['subject-partly-covered']);
});

function reportWith(planIssues, runtime) {
  return buildQualityReport({ planIssues, runtime });
}

test('quality report: per-scene entries with range, issues, correction and validation status', () => {
  const plan = buildScenePlan({ img: null, duration: 4, factTitle: 'DID YOU KNOW?', factSubtitle: 'The Great Pyramid of Giza aligns with true north.' });
  const rt = prepareScene({ duration: 4, scenePlan: plan, probe: false });
  const frames = steady(120);
  for (let i = 70; i < 100; i++) frames[i] = frame({ meanLuma: 250, clipFrac: 0.95 });
  const series = analyzeFrameSeries(frames, { cutFrames: rt.shots.slice(1).map((s) => Math.round(s.start * 30)) });
  const report = buildQualityReport({
    fileName: 'x.mp4',
    container: { validMp4: true, fastStart: true, codec: 'H.264 (avc1)', width: 1080, height: 1920, fps: 30, isConstant30Fps: true, frameCount: 120, durationSec: 4, keyframeCount: 5, hasAudioTrack: false, colour: { fullRange: false }, bitstreamFullRange: false, byteLength: 1000, problems: [] },
    decode: { decoderAvailable: true, decodedFrames: 120, expectedFrames: 120, errors: [] },
    expected: { frames: 120, width: 1080, height: 1920 },
    seriesIssues: series,
    planIssues: evaluateScenePlan(rt),
    runtime: rt,
    frameStats: frames
  });

  assert.equal(report.summary.status, 'fail');
  assert.equal(report.scenes.length, rt.shots.length);
  const hit = report.scenes.find((s) => s.issues.some((i) => i.code === 'overexposure'));
  assert.ok(hit, 'the overexposure is attributed to the scene it happens in');
  assert.ok(hit.range.startFrame <= 70 && hit.range.endFrame >= 70);
  for (const scene of report.scenes) {
    assert.ok(scene.id && scene.range.end > scene.range.start);
    assert.ok(scene.metrics && Number.isFinite(scene.metrics.meanLuma));
    for (const it of scene.issues) {
      assert.ok(['error', 'warning', 'info'].includes(it.severity));
      assert.ok(['objective', 'heuristic'].includes(it.kind), 'every issue says whether it is objective or heuristic');
      assert.ok(it.correction && it.correction.status);
      assert.ok(['pass', 'fail', 'unverified'].includes(it.validation));
    }
  }
  assert.ok(report.notEvaluated.some((n) => /Semantic relevance/.test(n)), 'what was not evaluated is stated');
  assert.ok(report.notEvaluated.some((n) => /no audio track/.test(n)), 'a silent clip is not reported as an audio error');
  assert.ok(!listIssues(report).some((i) => /audio/i.test(i.code)));
});

test('objective file checks: decode errors, wrong frame count and a colour-tag mismatch are reported', () => {
  const report = buildQualityReport({
    container: { validMp4: true, fastStart: true, codec: 'H.264 (avc1)', width: 1080, height: 1920, fps: 30, isConstant30Fps: true, frameCount: 90, durationSec: 3, keyframeCount: 3, hasAudioTrack: false, colour: { fullRange: true }, bitstreamFullRange: false, byteLength: 1, problems: [] },
    decode: { decoderAvailable: true, decodedFrames: 60, expectedFrames: 90, errors: ['Decoder failed after 60 of 90 frames: Decoding error.'] },
    expected: { frames: 120, width: 1080, height: 1920 }
  });
  const found = codes(report.video.issues);
  assert.ok(found.includes('decode-error'));
  assert.ok(found.includes('frame-count'));
  assert.ok(found.includes('colour-range-mismatch'));
  assert.equal(report.summary.status, 'fail');
  assert.ok(report.video.issues.filter((i) => i.code !== 'colour-range-mismatch').every((i) => i.kind === 'objective'));
});

test('scoring: errors cost more than warnings; validated fixes cost nothing', () => {
  const err = { severity: 'error', correction: { status: 'pending' }, validation: 'unverified' };
  const warn = { severity: 'warning', correction: { status: 'pending' }, validation: 'unverified' };
  const fixed = { severity: 'info', correction: { status: 'applied' }, validation: 'pass' };
  assert.equal(scoreIssues([]), 100);
  assert.equal(scoreIssues([err]), 75);
  assert.equal(scoreIssues([warn, warn]), 84);
  assert.equal(scoreIssues([fixed]), 100);
  const a = { summary: { errors: 0, warnings: 2, score: 84 } };
  const b = { summary: { errors: 1, warnings: 0, score: 75 } };
  assert.equal(isBetterReport(a, b), true);
  assert.equal(isBetterReport(b, a), false);
  assert.equal(isBetterReport(a, null), true);
});

function sceneRuntime(planOverrides = {}) {
  const plan = { ...buildScenePlan({ img: null, duration: 5, modelId: 'viral-hook-v1', factTitle: 'DID YOU KNOW?', factSubtitle: 'Nobody knows how it was built. But the Great Pyramid aligns with true north almost perfectly!' }), ...planOverrides };
  return { plan, rt: prepareScene({ duration: 5, scenePlan: plan, probe: false }) };
}

function seriesReport(rt, sceneIndex, issue) {
  const report = reportWith([], rt);
  report.scenes[sceneIndex].issues.push({ ...issue, scope: report.scenes[sceneIndex].id });
  return report;
}
const repairable = (code, extra = {}) => ({ code, severity: 'error', kind: 'heuristic', message: code, repairable: true, correction: { status: 'pending' }, validation: 'unverified', ...extra });

test('repair: overexposure in one shot lowers effects for that shot only', () => {
  const { plan, rt } = sceneRuntime();
  const target = rt.shots[1].id;
  const repairs = proposeRepairs(seriesReport(rt, 1, repairable('overexposure')), plan, { runtime: rt });
  assert.deepEqual(Object.keys(repairs.plan.shotOverrides), [target]);
  assert.equal(repairs.plan.shotOverrides[target].fxGain, 0.45, 'no measurement → roughly halved');
  assert.equal(repairs.reencode, false);
  assert.equal(repairs.actions.length, 1);
  assert.equal(plan.shotOverrides, undefined, 'the original plan is not mutated');
});

test('repair strength follows the measurement: a heavy wash-out is cut hard in one step, across every scene it spans', () => {
  const { plan, rt } = sceneRuntime();
  const frames = steady(150, { meanLuma: 220 });
  const references = frames.map((_, i) => (i % 3 === 0 ? { lumaGain: 180, clipGain: 0.5, satGain: 0, subjectCorrelation: 0.9, subjectChanged: 0.1 } : null));
  const series = analyzeFrameSeries(frames, { references, cutFrames: rt.shots.slice(1).map((s) => Math.round(s.start * 30)) });
  const report = buildQualityReport({ seriesIssues: series, runtime: rt });
  for (const scene of report.scenes) {
    assert.ok(scene.issues.some((i) => i.code === 'overexposure'), `${scene.id} carries its share of the wash-out`);
  }
  const repairs = proposeRepairs(report, plan, { runtime: rt });
  for (const shot of rt.shots) {
    assert.ok(repairs.plan.shotOverrides[shot.id].fxGain <= 0.09, `${shot.id}: effects cut to ${repairs.plan.shotOverrides[shot.id].fxGain}`);
  }
});

test('repair table: each detected problem maps to its targeted action', () => {
  const { plan, rt } = sceneRuntime();
  const id = rt.shots[0].id;
  const apply = (issue, p = plan) => proposeRepairs(seriesReport(rt, 0, issue), p, { runtime: rt });

  assert.equal(apply(repairable('subject-cropped')).plan.shotOverrides[id].zoomScale, 0.9, 'camera crops subject → wider framing');
  assert.equal(apply(repairable('motion-jitter')).plan.shotOverrides[id].handheld, 0, 'jitter → sway removed');
  assert.ok(apply(repairable('frozen')).plan.shotOverrides[id].motionScale > rt.shots[0].motionScale, 'weak pacing → more camera travel');
  assert.equal(apply(repairable('caption-low-contrast')).plan.captionStyle.backdrop, 'card', 'unreadable captions → stronger backdrop');
  assert.equal(apply(repairable('decode-error')).reencode, true, 'corrupted frames → re-encode');
  assert.equal(apply(repairable('blank-frame')).reencode, true);

  const smaller = apply(repairable('subject-partly-covered', { severity: 'warning' }));
  assert.ok(smaller.plan.characterPlacement.heightFrac < rt.character.heightFrac, 'presenter covers subject → presenter shrinks');
  const gone = apply(repairable('presenter-covers-subject', { severity: 'warning' }));
  assert.equal(gone.plan.characterEnabled, false);
});

test('repair: a flash at a soft transition replaces it with a clean cut', () => {
  const { plan, rt } = sceneRuntime();
  const report = reportWith([], rt);
  const scene = report.scenes[1];
  scene.transitionIn = 'dissolve';
  scene.issues.push({ ...repairable('brightness-flash', { severity: 'warning' }), scope: scene.id, frames: [scene.range.startFrame + 2, scene.range.startFrame + 2] });
  const repairs = proposeRepairs(report, plan, { runtime: rt });
  assert.deepEqual(repairs.plan.shotOverrides[scene.id].transitionIn, { type: 'cut', duration: 0 });
});

test('retry limit: the same repair is attempted at most twice per issue, then reported as failed', () => {
  let { plan, rt } = sceneRuntime();
  const issueFor = () => seriesReport(rt, 0, repairable('subject-cropped'));
  for (let i = 0; i < MAX_REPAIRS_PER_ISSUE; i++) {
    const repairs = proposeRepairs(issueFor(), plan, { runtime: rt });
    assert.ok(repairs, `attempt ${i + 1} proposes a repair`);
    plan = repairs.plan;
  }
  const report = issueFor();
  assert.equal(proposeRepairs(report, plan, { runtime: rt }), null, 'no further attempts');
  assert.equal(report.scenes[0].issues[0].correction.status, 'failed');
});

test('nothing repairable → no repair proposed (no pointless re-render)', () => {
  const { plan, rt } = sceneRuntime();
  assert.equal(proposeRepairs(reportWith([], rt), plan, { runtime: rt }), null);
  const infoOnly = seriesReport(rt, 0, { code: 'caption-density', severity: 'warning', kind: 'heuristic', message: 'dense', repairable: false, correction: { status: 'not-repairable' }, validation: 'unverified' });
  assert.equal(proposeRepairs(infoOnly, plan, { runtime: rt }), null);
});

test('plan evaluation: a healthy default scene has no errors; text density is only a warning', () => {
  const { rt } = sceneRuntime();
  const issues = evaluateScenePlan(rt);
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0, JSON.stringify(issues.filter((i) => i.severity === 'error')));
  assert.ok(!codes(issues).includes('camera-out-of-bounds'));
  assert.ok(!codes(issues).includes('camera-jerk'));
  assert.ok(!codes(issues).includes('caption-outside-safe-zone'));
});

test('plan evaluation flags captions that are too brief to read', () => {
  const plan = buildScenePlan({ img: null, duration: 3, factSubtitle: 'One. Two. Three. Four. Five. Six. Seven. Eight.' });
  const rt = prepareScene({ duration: 3, scenePlan: plan, probe: false });
  assert.ok(codes(evaluateScenePlan(rt)).includes('caption-too-brief'));
});
