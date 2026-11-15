// Production pipeline: Plan → Pre-flight → Render → Inspect → Repair → Re-render → Validate.
//
// Rules the loop follows:
//  • Problems that can be found without rendering (caption layout, framing,
//    presenter placement, caption contrast, camera path) are fixed BEFORE the
//    first render — a pre-flight pass on the prepared scene costs milliseconds.
//  • After rendering, the finished MP4 is decoded and inspected. A repair that
//    only touches one shot re-renders only that shot (the exporter caches the
//    encoded samples of every unchanged shot).
//  • Attempts are capped, and the best attempt wins: a repair is never kept if
//    it made the result worse.

import { exportClipToMp4, clearSegmentCache, stableStringify, hashString } from './exporter.js';
import { prepareScene } from './renderer.js';
import {
  inspectVideo,
  evaluateScenePlan,
  buildQualityReport,
  proposeRepairs,
  isBetterReport,
  listIssues
} from './quality-inspector.js';

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;
const MAX_PREFLIGHT_PASSES = 4;

/**
 * Fix what can be fixed without rendering. Returns the adjusted plan and a log
 * of what was changed and why. Pure with respect to rendering: only
 * prepareScene (layout + low-res probes) runs.
 */
export function preflightScenePlan(sceneOptions, { maxPasses = MAX_PREFLIGHT_PASSES, prepare = prepareScene } = {}) {
  let plan = sceneOptions.scenePlan || {};
  const log = [];
  const seen = new Set([hashString(stableStringify(plan))]);

  for (let pass = 0; pass < maxPasses; pass++) {
    const runtime = prepare({ ...sceneOptions, scenePlan: plan });
    const issues = evaluateScenePlan(runtime);
    const report = buildQualityReport({ planIssues: issues, runtime });
    const repairs = proposeRepairs(report, plan, { runtime });
    if (!repairs) break;
    const signature = hashString(stableStringify(repairs.plan));
    // A repair that leads back to a plan we already tried would loop forever.
    if (seen.has(signature)) break;
    seen.add(signature);
    plan = repairs.plan;
    log.push({ stage: 'preflight', pass: pass + 1, actions: repairs.actions });
  }

  return { plan, log };
}

/**
 * Render a clip with automatic quality control and targeted repair.
 *
 * Returns:
 *   result    the export result of the best attempt ({ bytes, blob, verification, segments, … })
 *   report    the quality report of that attempt (with the repair history attached)
 *   scenePlan the plan that produced it (original + any repairs)
 *   attempts  one entry per render: score, issue counts, which shots were re-rendered
 */
export async function produceClip({
  autoRepair = true,
  maxRepairAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS,
  inspect = true,
  onStage = null,
  fileName = null,
  // Injection points for tests (default to the real implementations).
  exporter = exportClipToMp4,
  inspector = inspectVideo,
  prepare = prepareScene,
  ...exportOptions
}) {
  const stage = (name, detail = {}) => {
    if (typeof onStage === 'function') onStage({ stage: name, ...detail });
  };
  const sources = { img: exportOptions.img, customDrawFn: exportOptions.customDrawFn || null, characterImg: exportOptions.characterImg || null };
  const repairLog = [];
  const attempts = [];

  let plan = exportOptions.scenePlan || {};
  if (autoRepair) {
    stage('preflight');
    const pre = preflightScenePlan({ ...exportOptions, scenePlan: plan }, { prepare });
    plan = pre.plan;
    repairLog.push(...pre.log);
  }

  const limit = autoRepair ? Math.max(0, Math.floor(maxRepairAttempts)) : 0;
  const tried = new Set([hashString(stableStringify(plan))]);
  let best = null;
  let useCache = exportOptions.useCache !== false;

  for (let attempt = 0; attempt <= limit; attempt++) {
    stage('render', { attempt: attempt + 1 });
    const result = await exporter({ ...exportOptions, scenePlan: plan, useCache });

    let report;
    if (inspect && result.path === 'webcodecs') {
      stage('inspect', { attempt: attempt + 1 });
      report = await inspector({
        bytes: result.bytes,
        fileName,
        runtime: result.runtime,
        sources,
        expected: { frames: result.verification.frameCount, width: result.verification.width, height: result.verification.height },
        segments: result.segments,
        timings: result.timings
      });
    } else {
      // Not inspected frame by frame: either inspection was switched off, or the
      // output is a real-time recording that cannot be demuxed sample by sample.
      report = buildQualityReport({
        fileName,
        planIssues: result.runtime ? evaluateScenePlan(result.runtime) : [],
        runtime: result.runtime || null,
        segments: result.segments || [],
        timings: result.timings || null
      });
      report.objective.note = inspect
        ? 'Fallback real-time recording: container and frames were not inspected sample by sample.'
        : 'Frame inspection was disabled for this render.';
    }

    const reRendered = (result.segments || []).filter((s) => !s.cached).map((s) => s.id);
    attempts.push({
      attempt: attempt + 1,
      status: report.summary.status,
      score: report.summary.score,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      renderedShots: reRendered,
      reusedShots: (result.segments || []).filter((s) => s.cached).map((s) => s.id),
      totalMs: result.timings?.totalMs ?? null
    });

    // Mark earlier repairs as validated (or not) by this render.
    const openCodes = new Set(listIssues(report).filter((it) => it.severity !== 'info').map((it) => `${it.code}|${it.scope}`));
    for (const entry of repairLog) {
      if (entry.stage !== 'post-render' || entry.validatedBy) continue;
      entry.validatedBy = attempt + 1;
      entry.actions.forEach((a) => {
        a.validation = openCodes.has(`${a.code}|${a.scene || 'video'}`) ? 'fail' : 'pass';
      });
    }

    const candidate = { result, report, scenePlan: plan, attempt: attempt + 1 };
    if (isBetterReport(report, best ? best.report : null)) best = candidate;

    const clean = report.summary.errors === 0 && report.summary.warnings === 0;
    if (clean || attempt === limit) break;

    const repairs = proposeRepairs(report, plan, { runtime: result.runtime });
    if (!repairs) break;
    const signature = hashString(stableStringify(repairs.plan));
    if (tried.has(signature) && !repairs.reencode) break; // nothing new to try
    tried.add(signature);
    plan = repairs.plan;
    if (repairs.reencode) {
      clearSegmentCache();
      useCache = false;
    }
    repairLog.push({ stage: 'post-render', afterAttempt: attempt + 1, actions: repairs.actions });
  }

  best.report.repairs = {
    autoRepair,
    maxRepairAttempts: limit,
    attempts,
    log: repairLog,
    keptAttempt: best.attempt
  };

  stage('done', { status: best.report.summary.status, score: best.report.summary.score });
  return { ...best, attempts };
}
