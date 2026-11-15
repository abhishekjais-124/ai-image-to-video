// Automatic video quality inspector.
//
// Two kinds of result, always labelled:
//   • objective  — measured facts with a hard pass/fail (decodes fully, frame
//                  count, timestamps, caption inside the safe zone, camera
//                  inside the image, …)
//   • heuristic  — measured numbers judged against tuned thresholds (wash-out,
//                  flashes, frozen picture, jitter, caption contrast, subject
//                  visibility, pacing). Useful, but a judgement call.
//
// Not evaluated, and reported as such (no local model for it in this project):
// semantic scene relevance, face visibility, and anything about audio.
//
// The analysis functions are pure (arrays in, issues out) so they are unit
// tested in Node; only `inspectVideo` needs a browser (WebCodecs + canvas).

import { FIXED_FPS } from '../presets/fact-presets.js';
import { decodeH264Mp4, inspectMp4Buffer } from './mp4-muxer.js';
import { renderProbeFrame } from './renderer.js';
import { measureCameraPath, SUBJECT_VISIBILITY_FLOOR, projectImageBox, boxArea, intersectBoxes } from './camera.js';
import {
  computeFrameStats,
  lumaPlane,
  meanAbsDiff,
  structureCorrelation,
  changedFraction,
  median,
  DEFAULT_EXPOSURE_LIMITS
} from './frame-metrics.js';

export const QA_THRESHOLDS = Object.freeze({
  // Wash-out against the clean plate (the same frame without effects/overlays)
  washoutLumaGain: 35,
  washoutClipGain: 0.12,
  // Wash-out with no reference (inspecting an arbitrary file)
  absoluteClipWarn: 0.35,
  absoluteClipError: 0.6,
  absoluteLumaError: 225,
  sustainedFrames: 5,
  // Frame-to-frame brightness step that reads as a flash (outside cuts)
  flashLumaStep: 14,
  // No visible change for this long reads as a frozen picture
  frozenDiff: 0.06,
  frozenFrames: 24,
  // Unexpected jump: a non-cut frame that changes far more than its neighbours
  jumpFactor: 6,
  jumpMinDiff: 10,
  blankStd: 1.5,
  // Subject visibility against the clean plate
  subjectCorrelationMin: 0.55,
  subjectChangedMax: 0.22,
  subjectChangedObscured: 0.45,
  // Captions
  captionContrastMin: 4.5,
  captionMinSeconds: 0.5,
  // Camera
  cameraAccelMaxFraction: 0.012,
  // Pacing
  minShotSeconds: 0.8,
  maxCutsPerSecond: 1.2,
  saturationHighFrac: 0.5,
  saturationGain: 0.15
});

const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };

function issue(code, severity, kind, message, extra = {}) {
  return {
    code,
    severity,
    kind,
    message,
    scope: extra.scope || 'video',
    frames: extra.frames || null,
    time: extra.frames ? [Number((extra.frames[0] / FIXED_FPS).toFixed(3)), Number(((extra.frames[1] + 1) / FIXED_FPS).toFixed(3))] : extra.time || null,
    measured: extra.measured ?? null,
    suggestion: extra.suggestion || null,
    repairable: Boolean(extra.repairable),
    correction: { status: extra.repairable ? 'pending' : severity === 'info' ? 'not-needed' : 'not-repairable', action: null },
    validation: 'unverified'
  };
}

/** Contiguous runs of `true` in a boolean array, as [start, end] index pairs. */
export function findRuns(flags, minLength = 1) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minLength) runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
}

/**
 * Analyse the per-frame measurements of a decoded video.
 *
 * `frames[i]` = { meanLuma, stdLuma, clipFrac, satHighFrac, diffPrev }
 * `references[i]` (optional, sparse) = { lumaGain, clipGain, satGain, subjectCorrelation, subjectChanged }
 *    measured against the clean plate of the same frame.
 * `cutFrames` = frame indices where a planned cut happens (changes there are expected).
 * `softFrames` = frame indices inside a planned dissolve.
 */
export function analyzeFrameSeries(frames, { cutFrames = [], softFrames = [], references = null, thresholds = QA_THRESHOLDS } = {}) {
  const issues = [];
  const n = frames.length;
  if (n === 0) return issues;
  const cuts = new Set(cutFrames);
  const soft = new Set(softFrames);
  const T = thresholds;
  const hasRefs = Array.isArray(references) && references.some(Boolean);

  // --- Overexposure / wash-out
  if (hasRefs) {
    // Hold the last known reference between samples so runs are contiguous.
    let last = null;
    const washed = frames.map((_, i) => {
      if (references[i]) last = references[i];
      return Boolean(last && (last.lumaGain >= T.washoutLumaGain || last.clipGain >= T.washoutClipGain));
    });
    for (const [a, b] of findRuns(washed, T.sustainedFrames)) {
      const worst = Math.max(...references.slice(a, b + 1).filter(Boolean).map((r) => r.lumaGain), 0);
      issues.push(issue('overexposure', 'error', 'heuristic',
        `Effects wash the picture out for ${((b - a + 1) / FIXED_FPS).toFixed(2)}s (up to +${worst.toFixed(0)} luma over the clean image).`,
        { frames: [a, b], measured: { lumaGain: Number(worst.toFixed(1)) }, suggestion: 'Reduce the effects layer opacity for this shot.', repairable: true }));
    }
  } else {
    const errorRun = frames.map((f) => f.clipFrac >= T.absoluteClipError || f.meanLuma >= T.absoluteLumaError);
    const warnRun = frames.map((f, i) => !errorRun[i] && f.clipFrac >= T.absoluteClipWarn);
    for (const [a, b] of findRuns(errorRun, T.sustainedFrames)) {
      const peak = Math.max(...frames.slice(a, b + 1).map((f) => f.clipFrac));
      issues.push(issue('overexposure', 'error', 'heuristic',
        `Picture is blown out for ${((b - a + 1) / FIXED_FPS).toFixed(2)}s (up to ${(peak * 100).toFixed(0)}% of the frame near white).`,
        { frames: [a, b], measured: { clipFrac: Number(peak.toFixed(3)) }, suggestion: 'Reduce glow / light effects; check for additive blending that accumulates.', repairable: true }));
    }
    for (const [a, b] of findRuns(warnRun, T.sustainedFrames)) {
      issues.push(issue('bright-frames', 'warning', 'heuristic',
        `Large near-white areas for ${((b - a + 1) / FIXED_FPS).toFixed(2)}s (no clean reference to compare against).`,
        { frames: [a, b], suggestion: 'Check whether the source image is this bright or an effect is adding it.' }));
    }
  }

  // --- Brightness flashes (frame-to-frame luma steps outside cuts and dissolves)
  for (let i = 1; i < n; i++) {
    if (cuts.has(i) || soft.has(i)) continue;
    const step = frames[i].meanLuma - frames[i - 1].meanLuma;
    if (Math.abs(step) >= T.flashLumaStep) {
      issues.push(issue('brightness-flash', 'warning', 'heuristic',
        `Brightness jumps by ${step > 0 ? '+' : ''}${step.toFixed(0)} luma in one frame.`,
        { frames: [i, i], measured: { lumaStep: Number(step.toFixed(1)) }, suggestion: 'Soften or remove the effect that fires here.', repairable: true }));
    }
  }

  // --- Frozen picture
  const still = frames.map((f, i) => i > 0 && f.diffPrev < T.frozenDiff);
  for (const [a, b] of findRuns(still, T.frozenFrames)) {
    issues.push(issue('frozen', 'warning', 'heuristic',
      `No visible change for ${((b - a + 1) / FIXED_FPS).toFixed(2)}s.`,
      { frames: [a, b], suggestion: 'Increase camera travel in this shot or add a change of framing.', repairable: true }));
  }

  // --- Blank / corrupt-looking frames and unexpected jumps
  const diffs = frames.slice(1).map((f) => f.diffPrev);
  const typical = median(diffs);
  for (let i = 1; i < n - 1; i++) {
    if (frames[i].stdLuma < T.blankStd && frames[i - 1].stdLuma > 8 && frames[i + 1].stdLuma > 8) {
      issues.push(issue('blank-frame', 'error', 'objective', 'A single flat/blank frame appears between normal frames.',
        { frames: [i, i], suggestion: 'Re-encode this segment.', repairable: true }));
    }
    if (cuts.has(i) || cuts.has(i + 1) || soft.has(i)) continue;
    const d = frames[i].diffPrev;
    if (d >= T.jumpMinDiff && d >= typical * T.jumpFactor && frames[i + 1].diffPrev >= T.jumpMinDiff * 0.6) {
      // A one-frame excursion that immediately jumps back: a glitch frame, not a cut.
      issues.push(issue('unexpected-jump', 'warning', 'heuristic',
        `The picture jumps at a point where no cut was planned (change ${d.toFixed(1)} vs typical ${typical.toFixed(2)}).`,
        { frames: [i, i], suggestion: 'Re-encode this segment; if it persists, replace the transition with a clean cut.', repairable: true }));
    }
  }

  // --- Planned cuts that do not actually change the picture
  for (const c of cuts) {
    if (c > 0 && c < n && frames[c].diffPrev < 1) {
      issues.push(issue('cut-not-visible', 'info', 'heuristic', 'A planned cut produces almost no visible change.', { frames: [c, c] }));
    }
  }

  // --- Motion jitter: frame-to-frame change that alternates instead of flowing
  const segmentBounds = [0, ...[...cuts].sort((a, b) => a - b), n];
  for (let s = 0; s < segmentBounds.length - 1; s++) {
    const a = segmentBounds[s] + 1;
    const b = segmentBounds[s + 1] - 1;
    if (b - a < 12) continue;
    const d = [];
    for (let i = a; i <= b; i++) d.push(frames[i].diffPrev);
    const typicalMotion = median(d);
    if (typicalMotion < 0.3) continue;
    let flips = 0;
    const second = [];
    for (let i = 2; i < d.length; i++) {
      const d1 = d[i] - d[i - 1];
      const d0 = d[i - 1] - d[i - 2];
      if (d1 * d0 < 0 && Math.abs(d1) > typicalMotion * 0.25 && Math.abs(d0) > typicalMotion * 0.25) flips++;
      second.push(Math.abs(d[i] - 2 * d[i - 1] + d[i - 2]));
    }
    const flipRate = flips / Math.max(1, d.length - 2);
    const roughness = median(second) / (typicalMotion + 0.05);
    if (flipRate > 0.55 && roughness > 0.6) {
      issues.push(issue('motion-jitter', 'warning', 'heuristic',
        `Motion is uneven frame to frame (alternation ${(flipRate * 100).toFixed(0)}%, roughness ${roughness.toFixed(2)}).`,
        { frames: [a, b], measured: { flipRate: Number(flipRate.toFixed(2)), roughness: Number(roughness.toFixed(2)) }, suggestion: 'Remove handheld sway / per-frame jitter in this shot.', repairable: true }));
    }
  }

  // --- Saturation
  const saturated = frames.map((f, i) => {
    if (f.satHighFrac < T.saturationHighFrac) return false;
    if (!hasRefs) return true;
    const ref = references[i];
    return Boolean(ref && ref.satGain >= T.saturationGain);
  });
  for (const [a, b] of findRuns(saturated, T.sustainedFrames)) {
    issues.push(issue('oversaturated', 'warning', 'heuristic',
      `Very saturated picture for ${((b - a + 1) / FIXED_FPS).toFixed(2)}s.`,
      { frames: [a, b], suggestion: 'Reduce effect intensity or colour tint.', repairable: true }));
  }

  // --- Subject visibility against the clean plate
  if (hasRefs) {
    let last = null;
    const hidden = frames.map((_, i) => {
      if (references[i]) last = references[i];
      return Boolean(
        last && last.subjectCorrelation !== null &&
        (last.subjectCorrelation < T.subjectCorrelationMin || last.subjectChanged >= T.subjectChangedObscured)
      );
    });
    for (const [a, b] of findRuns(hidden, T.sustainedFrames)) {
      const refs = references.slice(a, b + 1).filter(Boolean);
      const worst = Math.min(...refs.map((r) => r.subjectCorrelation));
      const covered = Math.max(...refs.map((r) => r.subjectChanged), 0);
      issues.push(issue('subject-obscured', 'error', 'heuristic',
        `The main subject is hard to recognise for ${((b - a + 1) / FIXED_FPS).toFixed(2)}s (structure match ${worst.toFixed(2)}, ${(covered * 100).toFixed(0)}% of it covered or changed).`,
        { frames: [a, b], measured: { subjectCorrelation: Number(worst.toFixed(3)), subjectChanged: Number(covered.toFixed(3)) }, suggestion: 'Lower effect opacity, or move/shrink whatever is drawn over the subject.', repairable: true }));
    }
    const covered = frames.map((_, i) => Boolean(
      references[i] && references[i].subjectCorrelation !== null &&
      references[i].subjectChanged >= T.subjectChangedMax && references[i].subjectChanged < T.subjectChangedObscured &&
      references[i].subjectCorrelation >= T.subjectCorrelationMin
    ));
    let lastCovered = false;
    const coveredHeld = covered.map((v, i) => {
      if (references[i]) lastCovered = v;
      return lastCovered;
    });
    for (const [a, b] of findRuns(coveredHeld, T.sustainedFrames)) {
      const peak = Math.max(...references.slice(a, b + 1).filter(Boolean).map((r) => r.subjectChanged), 0);
      issues.push(issue('subject-partly-covered', 'warning', 'heuristic',
        `An overlay covers ${(peak * 100).toFixed(0)}% of the subject area for ${((b - a + 1) / FIXED_FPS).toFixed(2)}s.`,
        { frames: [a, b], measured: { subjectChanged: Number(peak.toFixed(3)) }, suggestion: 'Move or shrink the presenter / overlay.', repairable: true }));
    }
  }

  return issues;
}

/**
 * Checks that need no pixels: caption layout, framing, presenter placement,
 * camera path and pacing, straight from the prepared scene.
 */
export function evaluateScenePlan(runtime, { thresholds = QA_THRESHOLDS } = {}) {
  const issues = [];
  const T = thresholds;
  const { duration, captionLayout: layout, timeline } = runtime;

  // --- Captions
  if (runtime.hasCaptions) {
    if (!layout.withinSafeZone) {
      issues.push(issue('caption-outside-safe-zone', 'error', 'objective', 'Caption text extends outside the platform safe zone.',
        { suggestion: 'Shorten the text or reduce caption size.', repairable: true }));
    }
    if (layout.overflow) {
      issues.push(issue('caption-too-many-lines', 'warning', 'objective', `A caption needs ${layout.maxLines} lines at the minimum font size.`,
        { suggestion: 'Shorten the phrase; long words cannot be split.' }));
    }
    for (const cue of layout.cues) {
      if (runtime.captionMode !== 'static' && cue.end - cue.start < T.captionMinSeconds) {
        issues.push(issue('caption-too-brief', 'warning', 'heuristic', `Caption "${cue.text}" is on screen for only ${(cue.end - cue.start).toFixed(2)}s.`,
          { time: [cue.start, cue.end], suggestion: 'Use fewer words or a longer clip.' }));
      }
    }
    const density = timeline.pacing?.textDensity;
    if (density && density > 1.3 && runtime.captionMode !== 'static') {
      issues.push(issue('caption-density', 'warning', 'heuristic',
        `The text needs about ${(density * 100 - 100).toFixed(0)}% more time than the clip has at a natural reading pace.`,
        { measured: { textDensity: density }, suggestion: 'Shorten the text or choose a longer clip duration.' }));
    }
    const cp = runtime.probe?.captions;
    if (cp && cp.contrastRatio < T.captionContrastMin) {
      issues.push(issue('caption-low-contrast', 'warning', 'heuristic',
        `Caption contrast against its background is ${cp.contrastRatio}:1 (target ≥ ${T.captionContrastMin}:1).`,
        { measured: cp, suggestion: 'Use a stronger caption backdrop.', repairable: cp.backdrop !== 'card' }));
    }
  }

  // --- Framing per shot
  for (const shot of runtime.shots) {
    const typeFloor = SUBJECT_VISIBILITY_FLOOR[shot.type] ?? 0.75;
    // If the subject is bigger than the caption-free area even at the widest framing,
    // judge the shot against what is achievable, and say so once.
    const limit = shot.visibilityLimit ?? 1;
    const floor = Math.min(typeFloor, limit);
    const vis = shot.subjectVisibility;
    if (vis && shot.type !== 'detail') {
      const worst = shot.type === 'reveal' ? vis.end : Math.min(vis.start, vis.end);
      if (limit < typeFloor - 0.06 && worst >= floor - 0.06) {
        issues.push(issue('subject-larger-than-safe-area', 'info', 'objective',
          `The subject fills more than the caption-free area: at the widest framing ${(limit * 100).toFixed(0)}% of it is clear of the captions.`,
          { scope: shot.id, time: [shot.start, shot.end], measured: { visibilityLimit: limit, ...vis } }));
      }
      if (worst < floor - 0.06) {
        issues.push(issue('subject-cropped', 'warning', 'objective',
          `Only ${(worst * 100).toFixed(0)}% of the subject stays inside the caption-free safe area in this shot.`,
          { scope: shot.id, time: [shot.start, shot.end], measured: vis, suggestion: 'Frame this shot wider.', repairable: true }));
      }
    }
    if (shot.type === 'detail' && shot.targetVisibility && Math.min(shot.targetVisibility.start, shot.targetVisibility.end) < 0.8) {
      issues.push(issue('closeup-target-cropped', 'warning', 'objective', 'The close-up target is partly outside the safe area.',
        { scope: shot.id, time: [shot.start, shot.end], measured: shot.targetVisibility, suggestion: 'Frame this shot wider.', repairable: true }));
    }
    const span = shot.end - shot.start;
    if (span < T.minShotSeconds) {
      issues.push(issue('shot-too-short', 'warning', 'heuristic', `Shot lasts ${span.toFixed(2)}s — too short to read.`,
        { scope: shot.id, time: [shot.start, shot.end], suggestion: 'Merge with a neighbouring shot.' }));
    }

    // Caption block sitting on the subject
    if (runtime.hasCaptions && shot.type !== 'detail' && shot.type !== 'pan') {
      const mid = (shot.start + shot.end) / 2;
      const projected = projectImageBox(runtime.saliency.subjectBox, runtime.cameraAt(mid).cam, runtime.geom);
      const area = boxArea(projected);
      const overlap = area > 0 ? boxArea(intersectBoxes(projected, layout.band)) / area : 0;
      if (overlap > 0.2) {
        issues.push(issue('caption-overlaps-subject', 'warning', 'objective',
          `Captions cover ${(overlap * 100).toFixed(0)}% of the subject in this shot.`,
          { scope: shot.id, time: [shot.start, shot.end], measured: { overlap: Number(overlap.toFixed(3)) }, suggestion: 'Frame this shot wider so the subject sits above the captions.', repairable: true }));
      }
    }
  }

  // --- Presenter
  if (runtime.character && runtime.character.acceptable === false) {
    issues.push(issue('presenter-covers-subject', 'warning', 'objective',
      `The presenter covers ${(runtime.character.occlusion * 100).toFixed(0)}% of the subject area even at the smallest size.`,
      { measured: { occlusion: runtime.character.occlusion }, suggestion: 'Disable the presenter for this image.', repairable: true }));
  }

  // --- Camera path: inside the image, and smooth
  const cutTimes = runtime.shots.slice(1).map((s) => s.start);
  const path = measureCameraPath((t) => runtime.cameraAt(t).cam, { duration, geom: runtime.geom, cutTimes });
  if (path.borderViolations > 0) {
    issues.push(issue('camera-out-of-bounds', 'error', 'objective', `The camera leaves the image on ${path.borderViolations} frame(s) (black borders).`,
      { measured: path, suggestion: 'Clamp the move to the image bounds.' }));
  }
  const accelLimit = runtime.dims.width * T.cameraAccelMaxFraction;
  if (path.maxAccel > accelLimit) {
    issues.push(issue('camera-jerk', 'warning', 'objective',
      `Camera acceleration peaks at ${path.maxAccel.toFixed(1)} px/frame² (limit ${accelLimit.toFixed(1)}).`,
      { measured: { maxAccel: Number(path.maxAccel.toFixed(2)) }, suggestion: 'Remove sway / emphasis punch, or use a softer easing.', repairable: true }));
  }

  // --- Pacing
  const cutsPerSecond = (runtime.shots.length - 1) / duration;
  if (cutsPerSecond > T.maxCutsPerSecond) {
    issues.push(issue('rapid-cuts', 'warning', 'heuristic', `${cutsPerSecond.toFixed(2)} cuts per second is faster than viewers can follow.`,
      { suggestion: 'Use fewer shots.' }));
  }
  for (let i = 1; i < runtime.shots.length; i++) {
    if (runtime.shots[i].type === runtime.shots[i - 1].type) {
      issues.push(issue('repetitive-shots', 'warning', 'heuristic', `Two "${runtime.shots[i].type}" shots in a row.`,
        { scope: runtime.shots[i].id, suggestion: 'Vary the shot type.' }));
    }
  }

  // --- Effects layer (already limited by the exposure probes)
  for (const s of runtime.probe?.shots || []) {
    if (s.attenuated) {
      const note = issue('effects-attenuated', 'info', 'heuristic',
        `Effects were reduced to ${(s.appliedGain * 100).toFixed(0)}% opacity in this shot to stay inside exposure limits.`,
        { scope: s.shotId, measured: s.worst });
      note.correction = { status: 'applied', action: `effects opacity ${s.requestedGain} → ${s.appliedGain}` };
      note.validation = s.worst && s.worst.ratio <= 1.05 ? 'pass' : 'fail';
      issues.push(note);
    }
    if (s.worst && s.worst.ratio > 1.15) {
      issues.push(issue('effects-exceed-limits', 'warning', 'heuristic',
        `Effects still exceed exposure limits by ${((s.worst.ratio - 1) * 100).toFixed(0)}% at minimum opacity.`,
        { scope: s.shotId, measured: s.worst, suggestion: 'Lower effectIntensity or remove the custom effect code.', repairable: true }));
    }
  }
  if (runtime.customCodeError) {
    issues.push(issue('custom-code-error', 'warning', 'objective', `The custom effect code threw an error: ${runtime.customCodeError}`,
      { suggestion: 'Fix or remove the custom scene code.' }));
  }
  if (runtime.probe?.error) {
    issues.push(issue('probe-failed', 'info', 'objective', `Exposure probes could not run: ${runtime.probe.error}`));
  }

  return issues;
}

/** 100 = clean. Errors cost 25, warnings 8, notes nothing. */
export function scoreIssues(issues) {
  let score = 100;
  for (const it of issues) {
    if (it.correction?.status === 'applied' && it.validation === 'pass') continue;
    if (it.severity === 'error') score -= 25;
    else if (it.severity === 'warning') score -= 8;
  }
  return Math.max(0, score);
}

function countBySeverity(issues) {
  const open = issues.filter((it) => !(it.correction?.status === 'applied' && it.validation === 'pass'));
  return {
    errors: open.filter((it) => it.severity === 'error').length,
    warnings: open.filter((it) => it.severity === 'warning').length,
    notes: issues.filter((it) => it.severity === 'info').length
  };
}

/** Is report A better than report B? (fewer errors, then fewer warnings, then higher score) */
export function isBetterReport(a, b) {
  if (!b) return true;
  if (a.summary.errors !== b.summary.errors) return a.summary.errors < b.summary.errors;
  if (a.summary.warnings !== b.summary.warnings) return a.summary.warnings < b.summary.warnings;
  return a.summary.score > b.summary.score;
}

/**
 * Assemble the consolidated quality report: objective file checks, one entry
 * per scene (shot) with its issues, and the list of things not evaluated.
 */
export function buildQualityReport({
  fileName = null,
  container = null,
  decode = null,
  expected = null,
  seriesIssues = [],
  planIssues = [],
  runtime = null,
  frameStats = null,
  segments = [],
  timings = null
}) {
  const fileIssues = [];
  const objective = {
    container: container
      ? {
          validMp4: container.validMp4,
          fastStart: container.fastStart,
          codec: container.codec,
          width: container.width,
          height: container.height,
          fps: container.fps,
          constantFrameRate: container.isConstant30Fps,
          frameCount: container.frameCount,
          durationSec: container.durationSec,
          keyframes: container.keyframeCount,
          hasAudioTrack: container.hasAudioTrack,
          colourTag: container.colour,
          bitstreamFullRange: container.bitstreamFullRange,
          sizeBytes: container.byteLength
        }
      : null,
    decode: decode
      ? { verified: decode.decoderAvailable, decodedFrames: decode.decodedFrames, expectedFrames: decode.expectedFrames, errors: decode.errors }
      : null
  };

  if (container) {
    for (const p of container.problems || []) fileIssues.push(issue('container-problem', 'error', 'objective', p, { suggestion: 'Re-encode the clip.', repairable: true }));
    if (!container.validMp4 && !(container.problems || []).length) {
      fileIssues.push(issue('container-invalid', 'error', 'objective', 'The file is not a valid H.264 MP4.', { suggestion: 'Re-encode the clip.', repairable: true }));
    }
    if (!container.fastStart) fileIssues.push(issue('not-faststart', 'warning', 'objective', 'The index (moov) is not at the start of the file.'));
    if (!container.isConstant30Fps) {
      fileIssues.push(issue('frame-rate', 'error', 'objective', `Frame rate is ${container.fps || 'variable'}, expected constant 30.000 fps.`, { suggestion: 'Re-encode the clip.', repairable: true }));
    }
    if (container.colour && container.bitstreamFullRange !== null && container.colour.fullRange !== container.bitstreamFullRange) {
      fileIssues.push(issue('colour-range-mismatch', 'warning', 'objective',
        `The container says ${container.colour.fullRange ? 'full' : 'limited'}-range colour but the video stream is ${container.bitstreamFullRange ? 'full' : 'limited'}-range; players that trust the container show wrong contrast.`,
        { suggestion: 'Re-export with the current engine (the tag now follows the stream).' }));
    }
    if (expected) {
      if (expected.frames && container.frameCount !== expected.frames) {
        fileIssues.push(issue('frame-count', 'error', 'objective', `File has ${container.frameCount} frames, expected ${expected.frames}.`, { suggestion: 'Re-encode the clip.', repairable: true }));
      }
      if (expected.width && (container.width !== expected.width || container.height !== expected.height)) {
        fileIssues.push(issue('resolution', 'error', 'objective', `File is ${container.width}×${container.height}, expected ${expected.width}×${expected.height}.`));
      }
    }
  }
  if (decode) {
    if (!decode.decoderAvailable) {
      fileIssues.push(issue('decode-not-verified', 'warning', 'objective', 'No video decoder available here — the file was not decoded.'));
    }
    for (const e of decode.errors || []) {
      if ((container?.problems || []).includes(e)) continue;
      if (e.includes('VideoDecoder (WebCodecs) is not available')) continue;
      fileIssues.push(issue('decode-error', 'error', 'objective', e, { suggestion: 'Re-encode the affected segment.', repairable: true }));
    }
  }

  // Assign frame-ranged issues to scenes.
  const shots = runtime ? runtime.shots : [];
  const scenes = shots.map((shot, index) => {
    const startFrame = Math.round(shot.start * FIXED_FPS);
    const endFrame = (index === shots.length - 1 && container ? container.frameCount : Math.round(shot.end * FIXED_FPS)) - 1;
    const seg = segments.find((s) => s.id === shot.id);
    return {
      id: shot.id,
      type: shot.type,
      intent: shot.intent || null,
      transitionIn: shot.transitionIn?.type || 'cut',
      range: { start: shot.start, end: shot.end, startFrame, endFrame },
      renderedFromCache: seg ? seg.cached : null,
      effectsOpacity: runtime.fxGains[index],
      subjectVisibility: shot.subjectVisibility || null,
      metrics: null,
      issues: []
    };
  });

  const videoIssues = [...fileIssues];
  const place = (it) => {
    if (it.scope && it.scope !== 'video') {
      const scene = scenes.find((s) => s.id === it.scope);
      if (scene) return scene.issues.push(it);
    }
    if (it.frames) {
      // A problem that runs across several scenes is reported in (and repaired for) each of them.
      const touched = scenes.filter((s) => it.frames[0] <= s.range.endFrame && it.frames[1] >= s.range.startFrame);
      if (touched.length) {
        for (const scene of touched) {
          const frames = [Math.max(it.frames[0], scene.range.startFrame), Math.min(it.frames[1], scene.range.endFrame)];
          scene.issues.push({
            ...it,
            scope: scene.id,
            frames,
            time: [Number((frames[0] / FIXED_FPS).toFixed(3)), Number(((frames[1] + 1) / FIXED_FPS).toFixed(3))],
            correction: { ...it.correction }
          });
        }
        return undefined;
      }
    }
    return videoIssues.push(it);
  };
  [...planIssues, ...seriesIssues].forEach(place);

  if (frameStats) {
    for (const scene of scenes) {
      const slice = frameStats.slice(scene.range.startFrame, scene.range.endFrame + 1);
      if (!slice.length) continue;
      const avg = (key) => slice.reduce((s, f) => s + f[key], 0) / slice.length;
      scene.metrics = {
        meanLuma: Number(avg('meanLuma').toFixed(1)),
        peakClipFraction: Number(Math.max(...slice.map((f) => f.clipFrac)).toFixed(4)),
        meanFrameChange: Number((slice.slice(1).reduce((s, f) => s + f.diffPrev, 0) / Math.max(1, slice.length - 1)).toFixed(3))
      };
    }
  }

  const all = [...videoIssues, ...scenes.flatMap((s) => s.issues)];
  const counts = countBySeverity(all);
  const score = scoreIssues(all);

  const notEvaluated = [
    'Semantic relevance of the visuals to the narration — needs a vision-language model; none is part of this project.',
    'Face visibility — no face detector is available locally.'
  ];
  if (!container || !container.hasAudioTrack) {
    notEvaluated.push('Audio (sync, clipping, loudness) — the clip has no audio track; this engine renders silent video.');
  } else {
    notEvaluated.push('Audio sync / clipping / loudness — an audio track is present but audio analysis is not implemented.');
  }

  return {
    reportVersion: 1,
    file: fileName,
    generatedAt: new Date().toISOString(),
    summary: {
      status: counts.errors > 0 ? 'fail' : counts.warnings > 0 ? 'pass-with-warnings' : 'pass',
      score,
      ...counts,
      scenes: scenes.length
    },
    legend: {
      objective: 'Measured fact with a hard pass/fail.',
      heuristic: 'Measured value judged against a tuned threshold — a quality estimate, not a guarantee.'
    },
    objective,
    video: {
      frames: frameStats ? frameStats.length : container?.frameCount ?? null,
      brightness: frameStats
        ? {
            minMeanLuma: Number(Math.min(...frameStats.map((f) => f.meanLuma)).toFixed(1)),
            maxMeanLuma: Number(Math.max(...frameStats.map((f) => f.meanLuma)).toFixed(1)),
            peakClipFraction: Number(Math.max(...frameStats.map((f) => f.clipFrac)).toFixed(4)),
            largestFrameToFrameLumaStep: Number(Math.max(0, ...frameStats.slice(1).map((f, i) => Math.abs(f.meanLuma - frameStats[i].meanLuma))).toFixed(2))
          }
        : null,
      timingSource: runtime ? runtime.timeline.timingSource : null,
      captions: runtime && runtime.hasCaptions
        ? {
            mode: runtime.captionMode,
            fontPx: runtime.captionLayout.fontPx,
            maxLines: runtime.captionLayout.maxLines,
            withinSafeZone: runtime.captionLayout.withinSafeZone,
            backdrop: runtime.backdrop,
            contrastRatio: runtime.probe?.captions?.contrastRatio ?? null,
            language: runtime.timeline.language
          }
        : null,
      presenter: runtime?.character
        ? { side: runtime.character.side, heightFraction: runtime.character.heightFrac, subjectOverlap: runtime.character.occlusion }
        : null,
      issues: videoIssues
    },
    scenes,
    notEvaluated,
    timings
  };
}

/**
 * Decode a finished MP4 and inspect every frame (browser only).
 * With `runtime` + `sources` the frames are also compared against clean plates
 * (the same frame without effects, presenter or captions) to measure wash-out
 * and subject visibility.
 */
export async function inspectVideo({
  bytes,
  fileName = null,
  runtime = null,
  sources = null,
  expected = null,
  segments = [],
  timings = null,
  referenceEvery = 3
}) {
  const container = inspectMp4Buffer(bytes);
  const aspect = container.width && container.height ? container.height / container.width : 16 / 9;
  const w = 270;
  const h = Math.max(2, Math.round(w * aspect));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const frameStats = [];
  const references = [];
  let prevLuma = null;
  let plateSurface = null;
  const canReference = Boolean(runtime && sources && sources.img);
  const size = { width: w, height: h };

  const decode = await decodeH264Mp4(bytes, {
    onFrame: (frame, index) => {
      ctx.drawImage(frame, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const stats = computeFrameStats(data, w, h);
      const luma = lumaPlane(data, w, h);
      frameStats.push({
        meanLuma: stats.meanLuma,
        stdLuma: stats.stdLuma,
        clipFrac: stats.clipFrac,
        satHighFrac: stats.satHighFrac,
        meanSat: stats.meanSat,
        diffPrev: prevLuma ? meanAbsDiff(luma, prevLuma) : 0
      });
      prevLuma = luma;

      let ref = null;
      if (canReference && index % referenceEvery === 0) {
        const t = Math.min(runtime.duration - 1e-4, index / FIXED_FPS);
        const plate = renderProbeFrame(runtime, sources, t, {
          layers: { fx: false, character: false, captions: false },
          size,
          target: plateSurface
        });
        if (plate) {
          plateSurface = plate.surface;
          const plateStats = computeFrameStats(plate.data, w, h);
          const plateLuma = lumaPlane(plate.data, w, h);
          const subject = runtime.subjectBoxAt(t);
          // Judge the subject only where captions are not deliberately drawn over it.
          const visible = { ...subject, y1: Math.min(subject.y1, runtime.hasCaptions ? runtime.captionLayout.band.y0 : 1) };
          const measurable = visible.y1 - visible.y0 > 0.04 && visible.x1 - visible.x0 > 0.04;
          ref = {
            lumaGain: stats.meanLuma - plateStats.meanLuma,
            clipGain: stats.clipFrac - plateStats.clipFrac,
            satGain: stats.satHighFrac - plateStats.satHighFrac,
            subjectCorrelation: measurable ? structureCorrelation(plateLuma, luma, w, h, visible, { ignoreAbove: 48 }) : null,
            subjectChanged: measurable ? changedFraction(plateLuma, luma, w, h, visible) : 0
          };
        }
      }
      references.push(ref);
    }
  });

  let cutFrames = [];
  let softFrames = [];
  if (runtime) {
    runtime.shots.slice(1).forEach((shot) => {
      const f = Math.round(shot.start * FIXED_FPS);
      if (shot.transitionIn?.type === 'dissolve') {
        const len = Math.round(shot.transitionIn.duration * FIXED_FPS);
        for (let i = f; i <= f + len; i++) softFrames.push(i);
      } else {
        cutFrames.push(f);
      }
    });
  }

  const seriesIssues = analyzeFrameSeries(frameStats, { cutFrames, softFrames, references: canReference ? references : null });

  const planIssues = runtime ? evaluateScenePlan(runtime) : [];

  return buildQualityReport({
    fileName,
    container,
    decode,
    expected,
    seriesIssues,
    planIssues,
    runtime,
    frameStats,
    segments,
    timings
  });
}

/* ============================================================================
   Repairs — targeted changes to the scene plan for issues the inspector found.
   Per-shot problems change only that shot's overrides, so only that shot's
   segment is re-rendered (see exporter segment cache).
   ============================================================================ */

function clonePlan(plan) {
  return JSON.parse(JSON.stringify(plan || {}));
}

const BACKDROP_ORDER = ['none', 'scrim', 'card'];
export const MAX_REPAIRS_PER_ISSUE = 2;

/**
 * Propose plan changes for the open, repairable issues in a report.
 * Returns { plan, actions, reencode } or null when there is nothing to change.
 */
export function proposeRepairs(report, scenePlan, { runtime = null } = {}) {
  const plan = clonePlan(scenePlan);
  plan.shotOverrides = plan.shotOverrides || {};
  const actions = [];
  let reencode = false;
  const handled = new Set();

  const allIssues = [
    ...report.video.issues.map((it) => ({ it, sceneId: null })),
    ...report.scenes.flatMap((scene) => scene.issues.map((it) => ({ it, sceneId: scene.id })))
  ].sort((a, b) => SEVERITY_RANK[b.it.severity] - SEVERITY_RANK[a.it.severity]);

  const override = (sceneId) => {
    plan.shotOverrides[sceneId] = plan.shotOverrides[sceneId] || {};
    return plan.shotOverrides[sceneId];
  };
  const sceneIds = report.scenes.map((s) => s.id);
  const record = (it, sceneId, action) => {
    it.correction = { status: 'applied', action };
    actions.push({ code: it.code, scene: sceneId, action });
  };

  // Retry limit: the same fix is tried at most MAX_REPAIRS_PER_ISSUE times for the same
  // issue in the same scene. After that the issue is reported as not fixed, never looped on.
  plan.repairHistory = plan.repairHistory || {};

  for (const { it, sceneId } of allIssues) {
    if (!it.repairable || it.severity === 'info') continue;
    const key = `${it.code}|${sceneId || 'video'}`;
    if (handled.has(key)) continue;
    handled.add(key);
    if ((plan.repairHistory[key] || 0) >= MAX_REPAIRS_PER_ISSUE) {
      it.correction = { status: 'failed', action: `gave up after ${MAX_REPAIRS_PER_ISSUE} repair attempts` };
      continue;
    }
    const before = actions.length;
    const targets = sceneId ? [sceneId] : sceneIds;

    switch (it.code) {
      case 'overexposure':
      case 'oversaturated':
      case 'effects-exceed-limits': {
        // Scale by how far over the limit the measurement is (so one repair is usually
        // enough); without a measurement, halve.
        const gainOver = it.measured?.lumaGain > 0 ? DEFAULT_EXPOSURE_LIMITS.maxLumaGain / it.measured.lumaGain : it.measured?.ratio > 1 ? 1 / it.measured.ratio : 0.5;
        const factor = Math.max(0.05, Math.min(0.6, gainOver * 0.9));
        for (const id of targets) {
          const o = override(id);
          const current = Number(o.fxGain ?? 1);
          // Already at the floor: turn the effects layer off for this shot.
          o.fxGain = current <= 0.04 ? 0 : Number(Math.max(0.03, current * factor).toFixed(3));
        }
        record(it, sceneId, `effects opacity ×${factor.toFixed(2)} for ${targets.join(', ')}`);
        break;
      }
      case 'brightness-flash': {
        const scene = report.scenes.find((s) => s.id === sceneId);
        const atBoundary = scene && it.frames && it.frames[0] - scene.range.startFrame <= 10 && scene.transitionIn !== 'cut';
        if (atBoundary) {
          override(sceneId).transitionIn = { type: 'cut', duration: 0 };
          record(it, sceneId, 'transition replaced with a clean cut');
        } else {
          for (const id of targets) {
            const o = override(id);
            o.fxGain = Number(Math.max(0.06, Number(o.fxGain ?? 1) * 0.6).toFixed(3));
          }
          if (plan.beatGlow !== false) plan.beatGlow = false;
          record(it, sceneId, 'emphasis glow disabled and effects opacity reduced');
        }
        break;
      }
      case 'subject-obscured':
      case 'subject-partly-covered':
      case 'presenter-covers-subject': {
        // A wash-out in the same scene is repaired by its own 'overexposure' issue first.
        const scene = report.scenes.find((s) => s.id === sceneId);
        if (it.code === 'subject-obscured' && scene && scene.issues.some((o) => o.code === 'overexposure')) {
          it.correction = { status: 'applied', action: 'covered by the overexposure repair for this scene' };
          break;
        }
        const placement = plan.characterPlacement || (runtime?.character ? { heightFrac: runtime.character.heightFrac } : null);
        const coveredByOverlay = it.code !== 'subject-obscured' || (it.measured && it.measured.subjectChanged >= 0.15);
        if (plan.characterEnabled !== false && coveredByOverlay && placement) {
          const nextHeight = Number((Number(placement.heightFrac ?? 0.3) * 0.8).toFixed(3));
          if (nextHeight < 0.17 || it.code === 'presenter-covers-subject') {
            plan.characterEnabled = false;
            delete plan.characterPlacement;
            record(it, sceneId, 'presenter disabled (it could not be placed without covering the subject)');
          } else {
            plan.characterPlacement = { ...(plan.characterPlacement || {}), heightFrac: nextHeight };
            record(it, sceneId, `presenter scaled down to ${(nextHeight * 100).toFixed(0)}% of frame height`);
          }
        } else {
          for (const id of targets) {
            const o = override(id);
            o.fxGain = Number(Math.max(0, Number(o.fxGain ?? 1) * 0.5).toFixed(3));
          }
          record(it, sceneId, `effects opacity halved for ${targets.join(', ')}`);
        }
        break;
      }
      case 'caption-low-contrast': {
        const current = plan.captionStyle?.backdrop && plan.captionStyle.backdrop !== 'auto' ? plan.captionStyle.backdrop : runtime?.backdrop || 'none';
        const next = BACKDROP_ORDER[Math.min(BACKDROP_ORDER.length - 1, BACKDROP_ORDER.indexOf(current) + 1)];
        if (next !== current) {
          plan.captionStyle = { ...(plan.captionStyle || {}), backdrop: next };
          record(it, sceneId, `caption backdrop ${current} → ${next}`);
        }
        break;
      }
      case 'caption-outside-safe-zone': {
        const scale = Number(plan.captionStyle?.sizeScale ?? 1);
        if (scale > 0.72) {
          plan.captionStyle = { ...(plan.captionStyle || {}), sizeScale: Number((scale * 0.9).toFixed(3)) };
          record(it, sceneId, 'caption size reduced 10%');
        }
        break;
      }
      case 'subject-cropped':
      case 'closeup-target-cropped':
      case 'caption-overlaps-subject': {
        for (const id of targets) {
          const o = override(id);
          o.zoomScale = Number(Math.max(0.6, Number(o.zoomScale ?? 1) * 0.9).toFixed(3));
        }
        record(it, sceneId, `framing widened 10% for ${targets.join(', ')}`);
        break;
      }
      case 'camera-jerk':
      case 'motion-jitter': {
        for (const id of targets) override(id).handheld = 0;
        plan.beatPunch = 0;
        plan.handheld = 0;
        plan.gateWeave = 0;
        record(it, sceneId, 'handheld sway and emphasis punch removed');
        break;
      }
      case 'frozen': {
        for (const id of targets) {
          const o = override(id);
          const shot = runtime?.shots.find((s) => s.id === id);
          o.motionScale = Number(Math.min(1.6, Number(o.motionScale ?? shot?.motionScale ?? 1) * 1.4).toFixed(3));
        }
        record(it, sceneId, `camera travel increased for ${targets.join(', ')}`);
        break;
      }
      case 'unexpected-jump': {
        const scene = report.scenes.find((s) => s.id === sceneId);
        if (scene && scene.transitionIn !== 'cut' && it.frames && it.frames[0] - scene.range.startFrame <= 10) {
          override(sceneId).transitionIn = { type: 'cut', duration: 0 };
          record(it, sceneId, 'transition replaced with a clean cut');
        } else {
          reencode = true;
          record(it, sceneId, 're-encode with the software encoder');
        }
        break;
      }
      case 'blank-frame':
      case 'decode-error':
      case 'container-problem':
      case 'container-invalid':
      case 'frame-rate':
      case 'frame-count':
        reencode = true;
        record(it, sceneId, 're-encode without cache');
        break;
      default:
        break;
    }
    if (actions.length > before) plan.repairHistory[key] = (plan.repairHistory[key] || 0) + 1;
  }

  if (actions.length === 0) return null;
  if (Object.keys(plan.shotOverrides).length === 0) delete plan.shotOverrides;
  return { plan, actions, reencode };
}

/** Flat list of every issue in a report (video-level first). */
export function listIssues(report) {
  return [...report.video.issues, ...report.scenes.flatMap((s) => s.issues)];
}
