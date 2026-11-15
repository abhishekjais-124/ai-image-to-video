// End-to-end tests: the real pipeline (Canvas 2D + WebCodecs) in headless Chrome.
// Each test renders an actual clip, decodes it back and checks the result.
// Requires a Chromium-family browser on this machine (no downloads, no network).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStudioServer, launchBrowser, findBrowserPath, PROJECT_ROOT } from '../../scripts/lib/headless-chrome.js';

let browserAvailable = true;
try {
  findBrowserPath();
} catch (_) {
  browserAvailable = false;
}

const SAMPLE = '/media/samples/sample-ancient-pyramid.svg';
const EN = 'The Great Pyramid of Giza aligns with true north within 3/60th of a single degree.';
const HI = 'गीज़ा का महान पिरामिड आज भी एक रहस्य है। यह लगभग पूरी तरह उत्तर दिशा की ओर बना है।';

let server = null;
let browser = null;
let page = null;

const call = (expression, timeoutMs = 240_000) => page.evaluate(expression, { timeoutMs });
const studio = (method, arg) => call(`window.studio.${method}(${JSON.stringify(arg)})`);
const buildPlan = (options = {}) =>
  studio('buildPlan', { imageSrc: SAMPLE, modelId: 'saliency-vision', duration: 3, factTitle: 'DID YOU KNOW?', factSubtitle: EN, variationSeed: 2, ...options });
const allIssues = (report) => [...report.video.issues, ...report.scenes.flatMap((s) => s.issues)];

before(async () => {
  if (!browserAvailable) return;
  server = await startStudioServer();
  browser = await launchBrowser();
  page = await browser.newPage(`${server.url}/src/headless.html`);
  await call('new Promise((r) => { const wait = () => (window.studio && window.studio.ready ? r(true) : setTimeout(wait, 20)); wait(); })', 20_000);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.stop();
});

const e2e = (name, fn) => test(name, { skip: browserAvailable ? false : 'no Chromium-family browser found', timeout: 300_000 }, fn);

e2e('renders a 3s clip: 90 frames, 1080×1920, constant 30 fps, H.264 MP4, every frame decodes', async () => {
  await studio('clearCache', null);
  const plan = await buildPlan();
  const out = await studio('render', { plan, quality: 'fast' });

  const c = out.report.objective.container;
  assert.equal(out.path, 'webcodecs');
  assert.equal(c.validMp4, true);
  assert.equal(c.fastStart, true);
  assert.equal(c.codec, 'H.264 (avc1)');
  assert.equal(c.width, 1080);
  assert.equal(c.height, 1920);
  assert.equal(c.fps, 30);
  assert.equal(c.constantFrameRate, true);
  assert.equal(c.frameCount, 90, 'frame count');
  assert.equal(c.durationSec, 3, 'duration');
  assert.equal(c.hasAudioTrack, false);
  assert.equal(c.colourTag.fullRange, c.bitstreamFullRange, 'colour tag matches the bitstream');

  const d = out.report.objective.decode;
  assert.equal(d.verified, true);
  assert.equal(d.decodedFrames, 90, 'every frame decodes');
  assert.deepEqual(d.errors, []);
  assert.equal(out.verification.decodeVerified, true);
  assert.equal(out.verification.decodedFrames, 90);

  assert.equal(out.report.summary.errors, 0, JSON.stringify(allIssues(out.report).filter((i) => i.severity === 'error')));
  // Each scene starts on a keyframe so it can be regenerated independently.
  assert.ok(c.keyframes >= out.report.scenes.length);
});

e2e('regression (pyramid sample, seed 2): no wash-out, no flashes, subject stays recognisable, captions readable', async () => {
  const plan = await buildPlan();
  const out = await studio('render', { plan, quality: 'fast' });
  const b = out.report.video.brightness;

  // The broken "before" sample climbed to mean luma 254 with 91% of the frame near white.
  assert.ok(b.maxMeanLuma < 70, `mean luma stays in the image's own range (max ${b.maxMeanLuma})`);
  assert.ok(b.peakClipFraction < 0.03, `near-white area stays small (${b.peakClipFraction})`);

  const codes = allIssues(out.report).filter((i) => i.severity !== 'info').map((i) => i.code);
  for (const bad of ['overexposure', 'brightness-flash', 'subject-obscured', 'subject-partly-covered', 'decode-error', 'blank-frame', 'unexpected-jump', 'motion-jitter', 'camera-out-of-bounds', 'caption-outside-safe-zone', 'caption-low-contrast']) {
    assert.ok(!codes.includes(bad), `no "${bad}" issue`);
  }
  const caps = out.report.video.captions;
  assert.equal(caps.withinSafeZone, true);
  assert.ok(caps.maxLines <= 2);
  assert.ok(caps.contrastRatio >= 4.5, `caption contrast ${caps.contrastRatio}:1`);
  assert.ok(out.report.video.presenter.subjectOverlap <= 0.1, 'presenter does not cover the subject');
});

e2e('cinematic quality: same brightness as fast quality (motion-blur accumulation neither darkens nor brightens)', async () => {
  const plan = await buildPlan();
  const fast = await studio('render', { plan, quality: 'fast' });
  const cine = await studio('render', { plan, quality: 'cinematic' });
  assert.equal(cine.report.objective.decode.decodedFrames, 90);
  assert.equal(cine.report.summary.errors, 0);
  fast.report.scenes.forEach((scene, i) => {
    const delta = Math.abs(scene.metrics.meanLuma - cine.report.scenes[i].metrics.meanLuma);
    assert.ok(delta < 2.5, `${scene.id}: fast ${scene.metrics.meanLuma} vs cinematic ${cine.report.scenes[i].metrics.meanLuma}`);
  });
});

e2e('effect brightness limit: an additive full-frame white effect is held inside exposure limits', async () => {
  const plan = await buildPlan({ characterEnabled: false });
  // The kind of code that produced the original white-out: additive white over the whole frame, every frame.
  plan.customCodeSource = `
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillRect(0, 0, params.width, params.height);
    ctx.fillStyle = 'rgba(255, 120, 220, 0.9)';
    ctx.fillRect(0, 0, params.width, params.height);
    ctx.restore();`;
  const out = await studio('render', { plan, quality: 'fast' });

  assert.equal(out.report.objective.decode.decodedFrames, 90);
  const b = out.report.video.brightness;
  assert.ok(b.maxMeanLuma < 80, `frame is not washed out (max mean luma ${b.maxMeanLuma})`);
  assert.ok(b.peakClipFraction < 0.06, `near-white area ${b.peakClipFraction}`);
  assert.ok(out.report.scenes.every((s) => s.effectsOpacity < 0.35), 'the effects layer was attenuated');
  const notes = allIssues(out.report).filter((i) => i.code === 'effects-attenuated');
  assert.ok(notes.length >= 1 && notes.every((n) => n.correction.status === 'applied'), 'the correction is recorded in the report');
  assert.ok(!allIssues(out.report).some((i) => i.code === 'overexposure' || i.code === 'subject-obscured'));
});

e2e('scene-level regeneration: changing one shot re-renders only that shot, and the result still decodes', async () => {
  await studio('clearCache', null);
  const plan = await buildPlan({ duration: 4 });
  const first = await studio('render', { plan, quality: 'fast', autoRepair: false });
  assert.ok(first.segments.length >= 2, 'the clip has more than one shot');
  assert.ok(first.segments.every((s) => !s.cached), 'first render: nothing cached');

  const again = await studio('render', { plan, quality: 'fast', autoRepair: false });
  assert.ok(again.segments.every((s) => s.cached), 'identical plan: every shot reused');
  assert.equal(again.report.objective.decode.decodedFrames, 120);
  assert.equal(again.report.objective.container.sizeBytes, first.report.objective.container.sizeBytes, 'cache hit reproduces the file exactly');

  const lastId = first.segments.at(-1).id;
  const changed = { ...plan, shotOverrides: { [lastId]: { fxGain: 0.3 } } };
  const repaired = await studio('render', { plan: changed, quality: 'fast', autoRepair: false });
  repaired.segments.forEach((s) => assert.equal(s.cached, s.id !== lastId, `${s.id} ${s.id === lastId ? 're-rendered' : 'reused'}`));
  assert.equal(repaired.report.objective.decode.decodedFrames, 120, 'mixed cached + fresh segments decode as one clip');
  assert.deepEqual(repaired.report.objective.decode.errors, []);
  assert.equal(repaired.report.objective.container.frameCount, 120);
  assert.equal(repaired.report.scenes.at(-1).effectsOpacity, 0.3);
});

e2e('rendering is deterministic: the same plan gives the same picture without the cache', async () => {
  const plan = await buildPlan();
  await studio('clearCache', null);
  const a = await studio('render', { plan, quality: 'fast', autoRepair: false, useCache: false });
  await studio('clearCache', null);
  const b = await studio('render', { plan, quality: 'fast', autoRepair: false, useCache: false });
  assert.deepEqual(a.report.video.brightness, b.report.video.brightness);
  assert.deepEqual(a.report.scenes.map((s) => s.metrics), b.report.scenes.map((s) => s.metrics));
});

e2e('Hindi (Devanagari) and 16:9: captions are drawn, inside the safe zone, and the clip decodes', async () => {
  const hindi = await buildPlan({ factTitle: 'क्या आप जानते हैं?', factSubtitle: HI, duration: 4, modelId: 'cinematic-doc-v1' });
  assert.equal(hindi.timeline.language, 'hi');
  const out = await studio('render', { plan: hindi, quality: 'fast' });
  assert.equal(out.report.objective.decode.decodedFrames, 120);
  assert.equal(out.report.summary.errors, 0);
  assert.equal(out.report.video.captions.language, 'hi');
  assert.equal(out.report.video.captions.withinSafeZone, true);
  assert.ok(out.report.video.captions.maxLines <= 2);

  // The caption layer really draws Devanagari text: frames with and without captions differ in the caption band.
  const diff = await call(`(async () => {
    const plan = ${JSON.stringify(hindi)};
    const withCaps = await window.studio.stills({ plan, times: [2.5], width: 270 });
    const without = await window.studio.stills({ plan, times: [2.5], width: 270, layers: { captions: false } });
    const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
    const [a, b] = await Promise.all([load(withCaps.stills[2.5]), load(without.stills[2.5])]);
    const c = document.createElement('canvas'); c.width = a.width; c.height = a.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(a, 0, 0); const da = x.getImageData(0, 0, c.width, c.height).data;
    x.drawImage(b, 0, 0); const db = x.getImageData(0, 0, c.width, c.height).data;
    let inBand = 0, outside = 0;
    for (let y = 0; y < c.height; y++) for (let px = 0; px < c.width; px++) {
      const i = (y * c.width + px) * 4;
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (d > 90) { if (y > c.height * 0.6 && y < c.height * 0.86) inBand++; else outside++; }
    }
    return { inBand, outside };
  })()`);
  assert.ok(diff.inBand > 300, `caption pixels drawn in the caption band (${diff.inBand})`);
  assert.ok(diff.outside < diff.inBand * 0.05, `captions stay in their band (${diff.outside} stray pixels)`);

  const wide = await buildPlan({ aspectRatio: '16:9', duration: 3 });
  const wideOut = await studio('render', { plan: wide, quality: 'fast' });
  assert.equal(wideOut.report.objective.container.width, 1920);
  assert.equal(wideOut.report.objective.container.height, 1080);
  assert.equal(wideOut.report.objective.decode.decodedFrames, 90);
  assert.equal(wideOut.report.video.captions.withinSafeZone, true);
});

e2e('a schema 1.0 scene plan (saved before this engine) still renders', async () => {
  const legacy = {
    schemaVersion: '1.0', modelId: 'viral-hook-v1', variationSeed: 2, presetId: '3d-perspective-tilt', aspectRatio: '9:16', resolution: '1080p',
    duration: 4, focusX: 0.5, focusY: 0.42, zoomStart: 1.02, zoomEnd: 1.28, panX: 0.018, panY: -0.005, rotateDeg: -1.06,
    particleCount: 80, vignetteStrength: 0.84, accentColor: '255, 225, 155', titleColor: '#fde047',
    factTitle: 'DID YOU KNOW?', factSubtitle: EN, imageSrc: SAMPLE,
    generatedCustomCode: "const { t, width, height, seededRandom } = params; const rng = seededRandom(135); ctx.save(); for (let i = 0; i < 75; i++) { const x = rng() * width; const y = ((rng() * height - t * 120) % height + height) % height; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255, 115, 25, 0.78)'; ctx.shadowBlur = 14; ctx.shadowColor = '#ff4500'; ctx.fill(); } ctx.restore();"
  };
  const out = await studio('render', { plan: legacy, quality: 'fast' });
  assert.equal(out.report.objective.container.frameCount, 120);
  assert.equal(out.report.objective.decode.decodedFrames, 120);
  assert.equal(out.report.scenes.length, 1);
  assert.equal(out.report.scenes[0].type, 'manual');
  assert.equal(out.report.summary.errors, 0, JSON.stringify(allIssues(out.report).filter((i) => i.severity === 'error')));
});

e2e('the inspector catches damaged files: corrupted frames and a truncated file', async () => {
  const plan = await buildPlan();
  const result = await call(`(async () => {
    const { exportClipToMp4 } = await import('/src/engine/exporter.js');
    const { extractH264Samples } = await import('/src/engine/mp4-muxer.js');
    const plan = ${JSON.stringify(plan)};
    const img = await new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = plan.imageSrc; });
    const good = await exportClipToMp4({ img, duration: 3, scenePlan: plan, factTitle: plan.factTitle, factSubtitle: plan.factSubtitle, presetId: plan.presetId, quality: 'fast', useCache: false });

    // 1. Corrupt the NAL header of the last 25 frames (what the old muxer bug did to small frames).
    const corrupted = new Uint8Array(good.bytes);
    const video = extractH264Samples(corrupted).structure.video;
    for (let i = video.sampleOffsets.length - 25; i < video.sampleOffsets.length; i++) corrupted[video.sampleOffsets[i] + 4] = 0x16;
    const corruptReport = await window.studio.inspect({ url: URL.createObjectURL(new Blob([corrupted])) });

    // 2. Cut the file short, as an interrupted write would.
    const truncated = good.bytes.subarray(0, Math.floor(good.bytes.length * 0.7));
    const truncReport = await window.studio.inspect({ url: URL.createObjectURL(new Blob([truncated])) });

    const goodReport = await window.studio.inspect({ url: URL.createObjectURL(new Blob([good.bytes])) });
    const summarise = (r) => ({ status: r.summary.status, decoded: r.objective.decode.decodedFrames, codes: r.video.issues.map((i) => i.code), kinds: r.video.issues.map((i) => i.kind) });
    return { good: summarise(goodReport), corrupt: summarise(corruptReport), trunc: summarise(truncReport) };
  })()`);

  assert.equal(result.good.status, 'pass');
  assert.equal(result.good.decoded, 90);

  assert.equal(result.corrupt.status, 'fail');
  assert.ok(result.corrupt.decoded < 90, `decode stops at the damage (${result.corrupt.decoded} frames)`);
  assert.ok(result.corrupt.codes.includes('decode-error'));

  assert.equal(result.trunc.status, 'fail');
  assert.ok(result.trunc.codes.some((c) => c === 'container-problem' || c === 'decode-error'));
});

e2e('regression fixtures: the original broken pyramid sample is flagged (skipped if the file is not on this machine)', async (t) => {
  const file = path.join(PROJECT_ROOT, 'media/outputs/sample-ancient-pyramid-saliency-vision-s2-9x16-1080p-30fps.mp4');
  if (!fs.existsSync(file)) return t.skip('before-sample not present');
  const report = await studio('inspect', { url: '/media/outputs/sample-ancient-pyramid-saliency-vision-s2-9x16-1080p-30fps.mp4', fileName: 'before-s2' });
  const codes = report.video.issues.map((i) => i.code);
  assert.equal(report.summary.status, 'fail');
  assert.ok(codes.includes('decode-error'), 'undecodable frames reported');
  assert.ok(codes.includes('overexposure'), 'white-out reported');
  assert.ok(codes.includes('colour-range-mismatch'), 'colour tag mismatch reported');
  assert.ok(report.objective.decode.decodedFrames < report.objective.decode.expectedFrames);
});
