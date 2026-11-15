import test from 'node:test';
import assert from 'node:assert/strict';
import { produceClip, preflightScenePlan, DEFAULT_MAX_REPAIR_ATTEMPTS } from '../../src/engine/pipeline.js';
import { buildQualityReport } from '../../src/engine/quality-inspector.js';
import { buildScenePlan } from '../../src/models/inhouse-models.js';
import { prepareScene } from '../../src/engine/renderer.js';
import { planRenderSegments } from '../../src/engine/exporter.js';

const TEXT = 'Nobody knows how it was built. But the Great Pyramid aligns with true north almost perfectly!';
const basePlan = () => buildScenePlan({ img: null, duration: 5, modelId: 'viral-hook-v1', factTitle: 'DID YOU KNOW?', factSubtitle: TEXT });
const prepare = (opts) => prepareScene({ ...opts, probe: false });
const issue = (code, scope, severity = 'error') => ({ code, severity, kind: 'heuristic', message: code, scope, repairable: true, correction: { status: 'pending' }, validation: 'unverified' });

/**
 * A fake renderer + inspector with a real segment cache model:
 * `problem(plan)` decides which issues the "video" has for a given plan.
 */
function harness(problem) {
  const calls = { renders: 0, renderedShots: [] };
  const cache = new Set();
  const exporter = async (opts) => {
    calls.renders++;
    const runtime = prepare(opts);
    const segments = planRenderSegments(runtime, {}).map((s) => {
      const cached = opts.useCache !== false && cache.has(s.signature);
      cache.add(s.signature);
      return { ...s, cached };
    });
    calls.renderedShots.push(segments.filter((s) => !s.cached).map((s) => s.id));
    return {
      bytes: new Uint8Array(4),
      path: 'webcodecs',
      runtime,
      segments,
      timings: { totalMs: 10 },
      verification: { frameCount: 150, width: 1080, height: 1920 }
    };
  };
  const inspector = async ({ runtime, segments }) => {
    const report = buildQualityReport({ runtime, segments });
    for (const it of problem(runtime.plan, runtime)) {
      const scene = report.scenes.find((s) => s.id === it.scope);
      (scene ? scene.issues : report.video.issues).push(it);
    }
    const all = [...report.video.issues, ...report.scenes.flatMap((s) => s.issues)];
    report.summary.errors = all.filter((i) => i.severity === 'error').length;
    report.summary.warnings = all.filter((i) => i.severity === 'warning').length;
    report.summary.score = Math.max(0, 100 - report.summary.errors * 25 - report.summary.warnings * 8);
    report.summary.status = report.summary.errors ? 'fail' : report.summary.warnings ? 'pass-with-warnings' : 'pass';
    return report;
  };
  return { calls, exporter, inspector };
}

const run = (h, extra = {}) =>
  produceClip({ img: null, duration: 5, scenePlan: basePlan(), exporter: h.exporter, inspector: h.inspector, prepare, ...extra });

test('a clean render is accepted after one pass — no unnecessary re-render', async () => {
  const h = harness(() => []);
  const out = await run(h);
  assert.equal(h.calls.renders, 1);
  assert.equal(out.report.summary.status, 'pass');
  assert.equal(out.attempts.length, 1);
});

test('scene-level regeneration: a defect in one shot re-renders only that shot', async () => {
  // Shot 2 is overexposed until its effects are at 50% or below.
  const h = harness((plan) => ((plan.shotOverrides?.['shot-2']?.fxGain ?? 1) > 0.5 ? [issue('overexposure', 'shot-2')] : []));
  const out = await run(h);
  assert.equal(h.calls.renders, 2);
  assert.deepEqual(h.calls.renderedShots[1], ['shot-2'], 'only the repaired shot was rendered again');
  assert.ok(out.attempts[1].reusedShots.length >= 1, 'the other shots came from cache');
  assert.equal(out.report.summary.status, 'pass');
  assert.equal(out.scenePlan.shotOverrides['shot-2'].fxGain, 0.45);
  const log = out.report.repairs.log.find((l) => l.stage === 'post-render');
  assert.equal(log.actions[0].validation, 'pass', 'the repair is validated by the re-render');
  assert.equal(out.report.repairs.keptAttempt, 2);
});

test('retry limit: an unfixable defect stops after the configured number of repair renders', async () => {
  const h = harness(() => [issue('overexposure', 'shot-1')]);
  const out = await run(h, { maxRepairAttempts: 2 });
  assert.equal(h.calls.renders, 3, '1 render + 2 repair renders, then stop');
  assert.equal(out.attempts.length, 3);
  assert.equal(out.report.summary.status, 'fail', 'the failure is reported, not hidden');
  assert.equal(DEFAULT_MAX_REPAIR_ATTEMPTS, 2);

  const once = harness(() => [issue('overexposure', 'shot-1')]);
  await run(once, { maxRepairAttempts: 0 });
  assert.equal(once.calls.renders, 1);
});

test('never worse: if a repair makes the result worse, the earlier render is kept', async () => {
  // First render: one warning. After the "repair": two errors.
  const h = harness((plan) =>
    plan.shotOverrides?.['shot-1']?.zoomScale ? [issue('overexposure', 'shot-1'), issue('blank-frame', 'shot-2')] : [issue('subject-cropped', 'shot-1', 'warning')]
  );
  const out = await run(h, { maxRepairAttempts: 1 });
  assert.equal(h.calls.renders, 2);
  assert.equal(out.report.summary.errors, 0, 'the first (better) render won');
  assert.equal(out.report.summary.warnings, 1);
  assert.equal(out.scenePlan.shotOverrides, undefined, 'the plan returned is the one that produced the kept render');
  assert.equal(out.report.repairs.keptAttempt, 1);
});

test('autoRepair off: one render, problems reported as found', async () => {
  const h = harness(() => [issue('overexposure', 'shot-1')]);
  const out = await run(h, { autoRepair: false });
  assert.equal(h.calls.renders, 1);
  assert.equal(out.report.summary.status, 'fail');
});

test('corrupted frames trigger a full re-encode without the cache', async () => {
  let first = true;
  const h = harness(() => {
    if (first) {
      first = false;
      return [{ ...issue('decode-error', 'video'), kind: 'objective' }];
    }
    return [];
  });
  const out = await run(h);
  assert.equal(h.calls.renders, 2);
  assert.equal(h.calls.renderedShots[1].length, out.result.segments.length, 'every shot re-rendered — nothing reused from a suspect cache');
  assert.equal(out.report.summary.status, 'pass');
});

test('preflight fixes plan-level problems before any render and always terminates', () => {
  const plan = { ...basePlan(), shotOverrides: { 'shot-1': { zoomScale: 1.9 } } };
  let prepared = 0;
  const counting = (opts) => {
    prepared++;
    return prepare(opts);
  };
  const out = preflightScenePlan({ img: null, duration: 5, scenePlan: plan }, { prepare: counting });
  assert.ok(prepared <= 5, `preflight is bounded (${prepared} passes)`);
  assert.ok(Array.isArray(out.log));
  for (const entry of out.log) assert.equal(entry.stage, 'preflight');
});
