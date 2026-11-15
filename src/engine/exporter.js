// Frame-Accurate 1080p+ / 30 FPS Video Exporter (WebCodecs H.264 + ISO-BMFF MP4 Muxer + Automatic Fallback)
// Guarantees Preview === Export frame-for-frame with 0 dropped frames.
//
// Reliability rules:
//  • A clip is rendered shot by shot. Every shot starts on a keyframe, so its
//    encoded samples are independently decodable and can be cached and reused:
//    repairing one shot re-renders that shot only.
//  • No file is returned as "verified" unless it was actually decoded end to end.

import { FIXED_FPS, getResolutionDims } from '../presets/fact-presets.js';
import { renderFrameAtTime, prepareScene } from './renderer.js';
import { muxH264SamplesToMp4, inspectMp4Buffer, decodeH264Mp4 } from './mp4-muxer.js';

export const ENGINE_VERSION = '2.0.0';

// Ordered from highest cross-platform compatibility (Baseline/Main/High L4.2 & L5.0 for 1080x1920 vertical)
const H264_CODEC_CANDIDATES = [
  'avc1.42002a', // Constrained Baseline Level 4.2 (most reliable across macOS/Windows/Webviews)
  'avc1.4d002a', // Main Profile Level 4.2
  'avc1.64002a', // High Profile Level 4.2
  'avc1.640032', // High Profile Level 5.0 (supports 1440p & 1080×1920 vertical)
  'avc1.4d0032', // Main Profile Level 5.0
  'avc1.640033', // High Profile Level 5.1
  'avc1.640028', // High Profile Level 4.0
  'avc1.42e02a',
  'avc1.42e01e'
];

/**
 * Fast unthrottled UI yield using MessageChannel (avoids setTimeout clamping in webviews)
 */
function yieldToUi() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(null);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export const RENDER_QUALITIES = [
  {
    id: 'fast',
    name: 'Fast',
    description: 'One render per frame. Quickest — good for checking a scene.'
  },
  {
    id: 'cinematic',
    name: 'Cinematic Natural',
    description: '4× motion-blur supersampling + 1440p render downscaled to 1080p, 20 Mbps. Several times the work of Fast.'
  }
];

/** Which story beat a frame belongs to — shown live in the UI. */
export function beatForProgress(progress) {
  if (progress < 0.34) return 'Walk in';
  if (progress < 0.74) return 'Point & talk';
  return 'React';
}

/**
 * Build the per-frame renderer shared by the WebCodecs and MediaRecorder
 * paths, so preview === export in both qualities.
 *
 * - fast: one renderFrameAtTime per 30 FPS frame.
 * - cinematic: 4 sub-renders spread across one frame duration (real
 *   motion blur — fast limbs/heads smear naturally instead of strobing),
 *   each rendered at 1440p and accumulated, then downscaled to the
 *   1080p output. That is ~9× the render work of fast mode, which is
 *   exactly what the 2–5 minute budget is for. Output is still
 *   30.000 FPS CFR, 1080p, H.264.
 * The finished frame is also mirrored to the stage canvas, so the UI
 * shows the frame being rendered live.
 */
export function makeFrameRenderer({
  offscreenCanvas, offCtx, width, height,
  img, duration, aspectRatio, resolution,
  presetId, factTitle, factSubtitle, scenePlan,
  customDrawFn, characterImg = null, mirrorCtx = null,
  quality = 'fast', runtime = null
}) {
  const cinematic = quality === 'cinematic';
  let hiCanvas = null;
  let hiCtx = null;
  let accumCanvas = null;
  let accumCtx = null;

  const mirror = () => {
    if (!mirrorCtx || !mirrorCtx.canvas) return;
    if (mirrorCtx.canvas.width !== width) mirrorCtx.canvas.width = width;
    if (mirrorCtx.canvas.height !== height) mirrorCtx.canvas.height = height;
    mirrorCtx.drawImage(offscreenCanvas, 0, 0);
  };

  const renderBase = (ctx, renderT, renderResolution) => {
    renderFrameAtTime(ctx, {
      img, t: renderT, duration, aspectRatio,
      resolution: renderResolution, presetId,
      factTitle, factSubtitle, scenePlan,
      customDrawFn, characterImg,
      // The prepared runtime matches the render resolution; pass it so every
      // frame uses exactly the decisions that were probed and quality-checked.
      runtime: runtime && runtime.resolution === renderResolution ? runtime : null
    });
  };

  return function renderFrame(t) {
    if (!cinematic) {
      renderBase(offCtx, t, resolution);
      mirror();
      return;
    }
    if (!hiCanvas) {
      const hi = getResolutionDims(aspectRatio, '1440p');
      hiCanvas = document.createElement('canvas');
      hiCanvas.width = hi.width;
      hiCanvas.height = hi.height;
      hiCtx = hiCanvas.getContext('2d', { alpha: false });
      accumCanvas = document.createElement('canvas');
      accumCanvas.width = hi.width;
      accumCanvas.height = hi.height;
      accumCtx = accumCanvas.getContext('2d', { alpha: false });
    }
    const samples = 4;
    accumCtx.save();
    accumCtx.clearRect(0, 0, accumCanvas.width, accumCanvas.height);
    accumCtx.fillStyle = '#000';
    accumCtx.fillRect(0, 0, accumCanvas.width, accumCanvas.height);
    // Additive accumulation: drawing with globalAlpha 0.25 four times
    // onto black does NOT sum to 1 — it converges to 1 - 0.75^4 = 0.68,
    // which made every cinematic frame 32% too dark. 'lighter' adds
    // 0.25 x 4 = 1.0 exactly.
    accumCtx.globalCompositeOperation = 'lighter';
    accumCtx.globalAlpha = 1 / samples;
    // Half-frame shutter (1/60s): a full-frame shutter at walk speed
    // ghosts the character into 4 separate copies. Half-frame gives a
    // natural smear on fast limbs and almost none when he is standing.
    // Sub-samples must stay inside the current shot: sampling across a cut would
    // blend two different shots into one ghosted frame.
    let lo = 0;
    let hi = duration - 1e-4;
    if (runtime && runtime.shots) {
      const shot = runtime.shots.find((sh) => t >= sh.start - 1e-6 && t < sh.end - 1e-6);
      if (shot) {
        lo = shot.start;
        hi = Math.min(hi, shot.end - 1e-4);
      }
    }
    for (let k = 0; k < samples; k++) {
      const tSub = Math.max(lo, Math.min(hi, t + ((k + 0.5) / samples - 0.5) * 0.5 / FIXED_FPS));
      renderBase(hiCtx, tSub, '1440p');
      accumCtx.drawImage(hiCanvas, 0, 0);
    }
    accumCtx.restore();
    // Supersampled downscale to the 1080p output canvas.
    offCtx.save();
    offCtx.globalAlpha = 1;
    offCtx.drawImage(accumCanvas, 0, 0, width, height);
    offCtx.restore();
    mirror();
  };
}

/**
 * Find the best supported H.264 WebCodecs configuration for the target 1080p/1440p dimensions at 30 FPS.
 */
export async function findSupportedH264Config(width, height, { preferSoftware = false } = {}) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoEncoder.isConfigSupported !== 'function') {
    return null;
  }

  // Ensure even dimensions required by H.264 4:2:0 macroblocks
  const evenW = width % 2 === 0 ? width : width + 1;
  const evenH = height % 2 === 0 ? height : height + 1;
  const bitrate = evenW * evenH > 1920 * 1080 ? 20_000_000 : 12_000_000;

  for (const codec of H264_CODEC_CANDIDATES) {
    for (const hardwareAcceleration of preferSoftware ? ['prefer-software'] : ['no-preference', 'prefer-hardware', 'prefer-software']) {
      try {
        const candidate = {
          codec,
          width: evenW,
          height: evenH,
          bitrate,
          framerate: FIXED_FPS,
          avc: { format: 'avc' },
          hardwareAcceleration
        };
        const res = await VideoEncoder.isConfigSupported(candidate);
        if (res && res.supported) {
          // Always preserve `avc: { format: 'avc' }`, width, height, framerate
          return {
            ...(res.config || {}),
            codec,
            width: evenW,
            height: evenH,
            bitrate,
            framerate: FIXED_FPS,
            hardwareAcceleration,
            avc: { format: 'avc' }
          };
        }
      } catch (_) {
        // Try next profile/level candidate
      }
    }
  }
  return null;
}

/* ============================================================================
   Segment cache — encoded samples per shot, keyed by everything that affects
   that shot's pixels. Unchanged shots are reused instead of re-rendered.
   ============================================================================ */

const SEGMENT_CACHE_LIMIT = 32;
const segmentCache = new Map(); // signature → { samples, avcDescription, frames }

export function clearSegmentCache() {
  segmentCache.clear();
}

export function segmentCacheSize() {
  return segmentCache.size;
}

/** JSON with sorted keys, so equal objects always serialise identically. Functions are skipped. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || value === undefined) return 'null';
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => typeof value[k] !== 'function' && value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** 53-bit string hash (cyrb53) — compact, deterministic cache keys. */
export function hashString(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function imageKey(img) {
  if (!img) return 'none';
  const src = String(img.currentSrc || img.src || '');
  return `${img.naturalWidth || img.width || 0}x${img.naturalHeight || img.height || 0}:${hashString(src)}`;
}

// Plan fields that never change pixels (or are covered elsewhere in the signature).
const NON_VISUAL_PLAN_KEYS = new Set([
  'timeline', 'shotOverrides', 'saliency', 'generatedCustomCode', 'customCodeSource',
  'analysisSummary', 'motionPrompt', 'imageSrc', 'schemaVersion', 'engine', 'totalFrames', 'fps', 'repairHistory'
]);

/**
 * Split a prepared scene into render segments (one per shot) and compute each
 * segment's cache signature. A change that only touches one shot (its framing,
 * its effect opacity, a per-shot override) changes only that shot's signature.
 */
export function planRenderSegments(runtime, { img = null, characterImg = null, customDrawFn = null, quality = 'fast', encoderKey = '' } = {}) {
  const totalFrames = Math.round(runtime.duration * FIXED_FPS);
  const globalPlan = {};
  for (const [key, value] of Object.entries(runtime.plan || {})) {
    if (!NON_VISUAL_PLAN_KEYS.has(key)) globalPlan[key] = value;
  }
  const layout = runtime.captionLayout;
  const shared = stableStringify({
    engine: ENGINE_VERSION,
    dims: runtime.dims,
    quality,
    encoderKey,
    duration: runtime.duration,
    presetId: runtime.presetId,
    mode: runtime.mode,
    image: imageKey(img),
    character: imageKey(characterImg),
    customCode: typeof customDrawFn === 'function' ? hashString(customDrawFn.toString()) : 'none',
    plan: globalPlan,
    saliency: runtime.saliency,
    title: runtime.title,
    captions: {
      mode: runtime.captionMode,
      style: runtime.captionStyle,
      backdrop: runtime.backdrop,
      fontPx: layout.fontPx,
      timingSource: runtime.timeline.timingSource,
      cues: layout.cues.map((c) => [c.start, c.end, c.text, c.lines.map((l) => l.words.map((w) => [w.text, w.emphasis, Math.round(w.x)]))])
    },
    placement: runtime.character,
    beats: runtime.beats,
    style: runtime.timeline.style
  });
  const sharedHash = hashString(shared);

  return runtime.shots.map((shot, index) => {
    const startFrame = Math.round(shot.start * FIXED_FPS);
    const endFrame = index === runtime.shots.length - 1 ? totalFrames : Math.round(shot.end * FIXED_FPS);
    const dissolveFrom = index > 0 && shot.transitionIn?.type === 'dissolve' ? { shot: runtime.shots[index - 1], gain: runtime.fxGains[index - 1] } : null;
    const own = stableStringify({ shot, gain: runtime.fxGains[index], dissolveFrom, startFrame, endFrame });
    return {
      id: shot.id,
      index,
      startFrame,
      endFrame,
      frames: endFrame - startFrame,
      signature: `${sharedHash}-${hashString(own)}`
    };
  });
}

function bytesEqual(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Primary WebCodecs H.264 frame-by-frame encoder -> In-House ISO-BMFF MP4 Muxer.
 * Renders and encodes only the segments that are not in the cache.
 */
async function encodeWithWebCodecs({
  h264Config,
  offscreenCanvas,
  width,
  height,
  totalFrames,
  segments,
  useCache,
  onProgress,
  renderFrame
}) {
  const frameDurationMicros = Math.round(1_000_000 / FIXED_FPS);
  const segmentOfFrame = new Array(totalFrames);
  for (const seg of segments) {
    for (let f = seg.startFrame; f < seg.endFrame; f++) segmentOfFrame[f] = seg.index;
  }

  const collected = segments.map(() => []);
  const cachedFlags = segments.map((seg) => useCache && segmentCache.has(seg.signature));
  let avcDescription = null;
  let encoderError = null;
  let lastTimestamp = -1;
  let reordered = false;

  const toEncode = segments.filter((seg) => !cachedFlags[seg.index]);
  let encoder = null;

  if (toEncode.length > 0) {
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !avcDescription) {
          avcDescription = new Uint8Array(meta.decoderConfig.description);
        }
        if (chunk.timestamp <= lastTimestamp) reordered = true;
        lastTimestamp = chunk.timestamp;
        const frameIndex = Math.round((chunk.timestamp * FIXED_FPS) / 1_000_000);
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        const segIndex = segmentOfFrame[frameIndex];
        if (segIndex !== undefined) {
          collected[segIndex].push({ data: buf, isKeyframe: chunk.type === 'key', frameIndex });
        }
      },
      error: (err) => {
        encoderError = err || new Error('VideoEncoder error');
      }
    });
    encoder.configure(h264Config);
  }

  let done = 0;
  const report = (phase) => {
    if (typeof onProgress === 'function') {
      onProgress({ frame: done, totalFrames, percent: Math.round((done / totalFrames) * 100), phase });
    }
  };

  try {
    for (const seg of segments) {
      if (cachedFlags[seg.index]) {
        done += seg.frames;
        report('encoding');
        continue;
      }
      for (let frameIndex = seg.startFrame; frameIndex < seg.endFrame; frameIndex++) {
        if (encoderError) throw encoderError;
        if (encoder.state === 'closed') throw new Error('VideoEncoder closed unexpectedly');

        renderFrame(frameIndex / FIXED_FPS);

        const videoFrame = new VideoFrame(offscreenCanvas, {
          timestamp: Math.round((frameIndex * 1_000_000) / FIXED_FPS),
          duration: frameDurationMicros
        });
        try {
          // Every segment starts on a keyframe (so it can be cached and reused), plus one per second.
          const offsetInSegment = frameIndex - seg.startFrame;
          encoder.encode(videoFrame, { keyFrame: offsetInSegment % FIXED_FPS === 0 });
        } finally {
          videoFrame.close();
        }

        // Keep encoder queue bounded
        let waitCycles = 0;
        while (encoder.encodeQueueSize > 10 && !encoderError && waitCycles < 500) {
          await new Promise((r) => setTimeout(r, 4));
          waitCycles++;
        }

        done++;
        report('encoding');
        if (frameIndex % 4 === 0) await yieldToUi();
      }
    }

    report('muxing');
    if (encoder) {
      await encoder.flush();
      if (encoderError) throw encoderError;
    }
  } finally {
    if (encoder && encoder.state !== 'closed') {
      try { encoder.close(); } catch (_) { /* already closed */ }
    }
  }

  if (reordered) {
    throw new Error('The encoder emitted frames out of presentation order (B-frames), which this muxer does not write.');
  }

  // Assemble: fresh segments from this session, cached ones from the cache.
  const samples = [];
  const segmentResults = [];
  for (const seg of segments) {
    let segSamples;
    let cached = false;
    if (cachedFlags[seg.index]) {
      const entry = segmentCache.get(seg.signature);
      // Cached samples are only valid with the exact same decoder configuration.
      if (avcDescription && !bytesEqual(avcDescription, entry.avcDescription)) {
        const err = new Error('Cached segment was encoded with a different decoder configuration');
        err.code = 'CACHE_CONFIG_MISMATCH';
        throw err;
      }
      if (!avcDescription) avcDescription = entry.avcDescription;
      segSamples = entry.samples;
      cached = true;
    } else {
      segSamples = collected[seg.index].sort((a, b) => a.frameIndex - b.frameIndex);
    }

    if (segSamples.length !== seg.frames) {
      throw new Error(`Segment ${seg.id}: encoder produced ${segSamples.length} samples for ${seg.frames} frames`);
    }
    if (!segSamples[0].isKeyframe) {
      throw new Error(`Segment ${seg.id} does not start with a keyframe`);
    }
    for (const sm of segSamples) samples.push({ data: sm.data, isKeyframe: sm.isKeyframe });
    segmentResults.push({ id: seg.id, startFrame: seg.startFrame, endFrame: seg.endFrame, frames: seg.frames, cached, signature: seg.signature });
  }

  if (samples.length !== totalFrames) {
    throw new Error(`Encoder produced ${samples.length} samples for ${totalFrames} frames`);
  }

  const mp4Bytes = muxH264SamplesToMp4({ width, height, fps: FIXED_FPS, avcDescription, samples });

  return {
    bytes: mp4Bytes,
    avcDescription,
    segmentResults,
    freshSamples: segments
      .filter((seg) => !cachedFlags[seg.index])
      .map((seg) => ({ signature: seg.signature, samples: collected[seg.index], frames: seg.frames }))
  };
}

function storeSegments(fresh, avcDescription) {
  for (const seg of fresh) {
    segmentCache.delete(seg.signature);
    segmentCache.set(seg.signature, { samples: seg.samples, avcDescription, frames: seg.frames });
  }
  while (segmentCache.size > SEGMENT_CACHE_LIMIT) {
    segmentCache.delete(segmentCache.keys().next().value);
  }
}

/** Check a non-WebCodecs recording by loading it into a <video> element. */
function probeWithVideoElement(blob) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve({ playable: false, reason: 'no document' });
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const finish = (info) => {
      URL.revokeObjectURL(url);
      resolve(info);
    };
    const timer = setTimeout(() => finish({ playable: false, reason: 'timed out loading metadata' }), 8000);
    video.muted = true;
    video.preload = 'auto';
    video.onloadeddata = () => {
      clearTimeout(timer);
      finish({ playable: true, width: video.videoWidth, height: video.videoHeight, durationSec: Number.isFinite(video.duration) ? video.duration : null });
    };
    video.onerror = () => {
      clearTimeout(timer);
      finish({ playable: false, reason: 'the browser could not decode the recording' });
    };
    video.src = url;
  });
}

/**
 * Export a clip deterministically frame-by-frame at 30.000 FPS Constant Frame Rate (CFR)
 * using the exact same `renderFrameAtTime` pipeline as the live preview stage.
 *
 * The returned `verification` is real: the container was parsed structurally and
 * (WebCodecs path) every frame was decoded back. If the first encode does not
 * decode cleanly, one automatic retry runs with a software encoder and no cache.
 */
export async function exportClipToMp4({
  img,
  duration = 4,
  aspectRatio = '9:16',
  resolution = '1080p',
  presetId = 'documentary-kenburns',
  factTitle = '',
  factSubtitle = '',
  scenePlan = {},
  customDrawFn = null,
  characterImg = null,
  mirrorCtx = null,
  onProgress = null,
  quality = 'fast',
  useCache = true,
  verifyDecode = true
}) {
  const { width, height } = getResolutionDims(aspectRatio, resolution);
  const totalFrames = Math.round(duration * FIXED_FPS);
  const startedAt = Date.now();
  const timings = {};

  // Live progress: elapsed + ETA + story beat, so the UI can show the
  // render happening instead of a bare percentage.
  const progressWithEta = (info) => {
    if (typeof onProgress !== 'function') return;
    const done = info.frame || 0;
    const elapsedMs = Date.now() - startedAt;
    const etaMs = done > 0 && done < totalFrames
      ? Math.round((elapsedMs * (totalFrames - done)) / done)
      : 0;
    onProgress({
      ...info,
      elapsedMs,
      etaMs,
      beat: beatForProgress(done / Math.max(1, totalFrames)),
      quality
    });
  };
  progressWithEta({ frame: 0, totalFrames, percent: 0, phase: 'analysing' });

  // Prepare the scene at the resolution frames are actually rendered at
  // (cinematic quality supersamples at 1440p), so probes and render agree.
  const renderResolution = quality === 'cinematic' ? '1440p' : resolution;
  const prepareStart = Date.now();
  const runtime = prepareScene({
    img, duration, aspectRatio, resolution: renderResolution, presetId,
    factTitle, factSubtitle, scenePlan, customDrawFn, characterImg
  });
  timings.prepareMs = Date.now() - prepareStart;

  const offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = width;
  offscreenCanvas.height = height;
  const offCtx = offscreenCanvas.getContext('2d', { alpha: false });

  const renderFrame = makeFrameRenderer({
    offscreenCanvas, offCtx, width, height,
    img, duration, aspectRatio, resolution,
    presetId, factTitle, factSubtitle, scenePlan,
    customDrawFn, characterImg, mirrorCtx, quality, runtime
  });

  const failures = [];

  // 1. Primary Path: WebCodecs H.264 -> In-House FastStart ISO-BMFF MP4 Muxer
  const attempts = [
    { preferSoftware: false, cache: useCache },
    { preferSoftware: true, cache: false }
  ];
  for (const attempt of attempts) {
    const h264Config = await findSupportedH264Config(width, height, { preferSoftware: attempt.preferSoftware });
    if (!h264Config) continue;
    if (quality === 'cinematic') h264Config.bitrate = 20_000_000;
    const encoderKey = `${h264Config.codec}|${h264Config.bitrate}|${h264Config.hardwareAcceleration || ''}`;
    const segments = planRenderSegments(runtime, { img, characterImg, customDrawFn, quality, encoderKey });

    try {
      const encodeStart = Date.now();
      let encoded;
      try {
        encoded = await encodeWithWebCodecs({
          h264Config, offscreenCanvas, width, height, totalFrames, segments,
          useCache: attempt.cache, onProgress: progressWithEta, renderFrame
        });
      } catch (err) {
        if (err.code !== 'CACHE_CONFIG_MISMATCH') throw err;
        // The encoder changed its parameter sets since the cached shots were made: re-render everything.
        for (const seg of segments) segmentCache.delete(seg.signature);
        encoded = await encodeWithWebCodecs({
          h264Config, offscreenCanvas, width, height, totalFrames, segments,
          useCache: false, onProgress: progressWithEta, renderFrame
        });
      }
      timings.renderEncodeMs = Date.now() - encodeStart;

      const verifyStart = Date.now();
      const verification = inspectMp4Buffer(encoded.bytes);
      const problems = [...verification.problems];
      if (!verification.validMp4) problems.push('Container failed structural validation');
      if (verification.frameCount !== totalFrames) problems.push(`Container has ${verification.frameCount} frames, expected ${totalFrames}`);
      if (!verification.isConstant30Fps) problems.push(`Frame rate is ${verification.fps}, expected constant 30`);
      if (verification.width !== width || verification.height !== height) {
        problems.push(`Output is ${verification.width}×${verification.height}, expected ${width}×${height}`);
      }

      let decodedFrames = null;
      if (verifyDecode && problems.length === 0) {
        progressWithEta({ frame: totalFrames, totalFrames, percent: 100, phase: 'verifying' });
        const decoded = await decodeH264Mp4(encoded.bytes);
        if (decoded.decoderAvailable) {
          decodedFrames = decoded.decodedFrames;
          problems.push(...decoded.errors);
        }
      }
      timings.verifyMs = Date.now() - verifyStart;

      if (problems.length > 0) {
        // Never cache or return a file that does not decode cleanly.
        for (const seg of segments) segmentCache.delete(seg.signature);
        throw new Error(`Output failed verification: ${problems.join('; ')}`);
      }

      storeSegments(encoded.freshSamples, encoded.avcDescription);
      timings.totalMs = Date.now() - startedAt;

      return {
        blob: new Blob([encoded.bytes], { type: 'video/mp4' }),
        bytes: encoded.bytes,
        ext: 'mp4',
        mimeType: 'video/mp4',
        path: 'webcodecs',
        runtime,
        segments: encoded.segmentResults,
        timings,
        failures,
        verification: {
          ...verification,
          decodeVerified: decodedFrames !== null,
          decodedFrames,
          frameAccurate: true,
          encoder: { codec: h264Config.codec, bitrate: h264Config.bitrate, hardwareAcceleration: h264Config.hardwareAcceleration || 'no-preference' }
        }
      };
    } catch (webCodecsErr) {
      failures.push(`${attempt.preferSoftware ? 'software' : 'default'} encoder: ${webCodecsErr.message || webCodecsErr}`);
      console.warn('WebCodecs H.264 attempt failed:', webCodecsErr);
    }
  }

  // 2. Fallback Path: MediaRecorder stepping through the unified renderer at 30 FPS.
  //    This is a real-time capture: it is NOT frame-accurate and is reported as such.
  if (typeof MediaRecorder === 'undefined') {
    throw new Error(`Video export failed (${failures.join(' | ') || 'no H.264 encoder available'}) and MediaRecorder is not available.`);
  }
  const mimeCandidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=h264',
    'video/webm;codecs=vp9',
    'video/webm'
  ];
  const supportedMime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';

  const stream = offscreenCanvas.captureStream(FIXED_FPS);
  const bitsPerSecond = quality === 'cinematic' ? 20_000_000 : 12_000_000;
  const recorder = new MediaRecorder(stream, supportedMime ? { mimeType: supportedMime, videoBitsPerSecond: bitsPerSecond } : { videoBitsPerSecond: bitsPerSecond });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopPromise = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e) => reject(e.error || new Error('MediaRecorder failed'));
  });

  recorder.start(100);
  const frameIntervalMs = 1000 / FIXED_FPS;

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      renderFrame(frameIndex / FIXED_FPS);
      progressWithEta({
        frame: frameIndex + 1,
        totalFrames,
        percent: Math.round(((frameIndex + 1) / totalFrames) * 100),
        phase: 'recording'
      });
      await new Promise((r) => setTimeout(r, frameIntervalMs));
    }
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopPromise.catch(() => {});
    stream.getTracks().forEach((track) => track.stop());
  }

  // Label the file as what it really is — a WebM is never saved with an .mp4 extension.
  const actualMime = (recorder.mimeType || supportedMime || 'video/webm').split(';')[0];
  const isMp4 = actualMime.includes('mp4');
  const blob = new Blob(chunks, { type: actualMime });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Video export failed: WebCodecs (${failures.join(' | ')}) and the MediaRecorder fallback produced no data.`);
  }
  const playback = await probeWithVideoElement(blob);
  if (!playback.playable) {
    throw new Error(`Video export failed: the fallback recording is not playable (${playback.reason}).`);
  }
  timings.totalMs = Date.now() - startedAt;

  return {
    blob,
    bytes,
    ext: isMp4 ? 'mp4' : 'webm',
    mimeType: actualMime,
    path: 'mediarecorder',
    runtime,
    segments: [],
    timings,
    failures,
    verification: {
      validMp4: isMp4,
      fastStart: false,
      codec: recorder.mimeType || supportedMime || actualMime,
      width: playback.width || width,
      height: playback.height || height,
      fps: FIXED_FPS,
      isConstant30Fps: false,
      frameCount: totalFrames,
      durationSec: playback.durationSec ?? duration,
      byteLength: bytes.byteLength,
      decodeVerified: false,
      decodedFrames: null,
      frameAccurate: false,
      problems: ['Real-time MediaRecorder capture: frame count and constant frame rate are not guaranteed.']
    }
  };
}

/**
 * Save rendered video bytes directly to `media/outputs/<fileName>` on the local server.
 * Non-fatal if server endpoint is unreachable (e.g. inside an embedded preview webview).
 */
export async function saveVideoToOutputs(bytes, fileName, { overwrite = false } = {}) {
  try {
    // By default an existing file is kept and this render is saved as -v2, -v3, …;
    // the response carries the name actually used.
    const res = await fetch(`/api/save-video?name=${encodeURIComponent(fileName)}${overwrite ? '&overwrite=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes
    });
    if (!res.ok) {
      return { ok: false, fileName, url: null };
    }
    return await res.json();
  } catch (_) {
    return { ok: false, fileName, url: null };
  }
}

/**
 * Save a quality report as `<video name>.qa.json` next to the video in `media/outputs/`.
 * Non-fatal if the server endpoint is unreachable.
 */
export async function saveReportToOutputs(report, videoFileName) {
  try {
    const stem = String(videoFileName || 'clip').replace(/\.[^.]+$/, '');
    const res = await fetch(`/api/save-report?name=${encodeURIComponent(`${stem}.qa.json`)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report, null, 2)
    });
    if (!res.ok) return { ok: false, fileName: null, url: null };
    return await res.json();
  } catch (_) {
    return { ok: false, fileName: null, url: null };
  }
}
