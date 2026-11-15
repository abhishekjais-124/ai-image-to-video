#!/usr/bin/env node
// Inspect any H.264 MP4: container structure, a full decode of every frame, and
// brightness / motion heuristics. Works on files from anywhere on disk.
//
//   npm run inspect -- media/outputs/clip.mp4
//   npm run inspect -- ~/Downloads/clip.mp4 --frames /tmp/frames --json

import fs from 'node:fs';
import path from 'node:path';
import { withStudioPage } from './lib/headless-chrome.js';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

if (!file || flag('help')) {
  console.log('Usage: npm run inspect -- <file.mp4> [--json] [--out report.json] [--frames <dir>] [--every <n>]');
  process.exit(file ? 0 : 1);
}

try {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${file}`);
  const base64 = fs.readFileSync(abs).toString('base64');
  const framesDir = option('frames');

  const { report, frames } = await withStudioPage('/src/headless.html', async (page) => {
    const payload = JSON.stringify({ base64, fileName: path.basename(abs) });
    const rep = await page.evaluate(`window.studio.inspect(${payload})`, { timeoutMs: 300_000 });
    let shots = null;
    if (framesDir) {
      const total = rep.objective.decode?.decodedFrames || rep.objective.container?.frameCount || 0;
      const every = Number(option('every')) || Math.max(1, Math.round(total / 6));
      const indices = [];
      for (let i = 0; i < total; i += every) indices.push(i);
      if (total > 0 && !indices.includes(total - 1)) indices.push(total - 1);
      shots = await page.evaluate(`window.studio.frames(${JSON.stringify({ base64, indices })})`, { timeoutMs: 300_000 });
    }
    return { report: rep, frames: shots };
  });

  if (frames) {
    fs.mkdirSync(framesDir, { recursive: true });
    const stem = path.basename(abs, path.extname(abs));
    for (const [index, dataUrl] of Object.entries(frames.frames)) {
      fs.writeFileSync(path.join(framesDir, `${stem}-f${String(index).padStart(3, '0')}.jpg`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
    console.log(`Saved ${Object.keys(frames.frames).length} frame(s) to ${framesDir}`);
  }

  const outFile = option('out');
  if (outFile) fs.writeFileSync(path.resolve(outFile), JSON.stringify(report, null, 2));

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const s = report.summary;
    const c = report.objective.container;
    const d = report.objective.decode;
    console.log(`${path.basename(abs)}`);
    console.log(`Quality: ${s.status.toUpperCase()}  score ${s.score}/100  (${s.errors} errors, ${s.warnings} warnings)`);
    console.log(`File: ${c.width}×${c.height}, ${c.fps} fps ${c.constantFrameRate ? 'CFR' : 'VFR'}, ${c.frameCount} frames, ${c.durationSec}s, ${c.codec}, audio track: ${c.hasAudioTrack ? 'yes' : 'no'}`);
    console.log(`Decode: ${d.decodedFrames}/${d.expectedFrames} frames decoded${d.errors.length ? '' : ', no errors'}`);
    const b = report.video.brightness;
    if (b) console.log(`Brightness: mean luma ${b.minMeanLuma}–${b.maxMeanLuma}, peak near-white area ${(b.peakClipFraction * 100).toFixed(1)}%, largest one-frame step ${b.largestFrameToFrameLumaStep}`);
    for (const it of report.video.issues) {
      const where = it.time ? ` @ ${it.time[0].toFixed(2)}–${it.time[1].toFixed(2)}s` : '';
      console.log(`  ${it.severity.toUpperCase().padEnd(7)} (${it.kind}) ${it.message}${where}`);
    }
    console.log('Not evaluated:');
    report.notEvaluated.forEach((n) => console.log(`  - ${n}`));
  }
  process.exit(report.summary.errors > 0 ? 2 : 0);
} catch (err) {
  console.error(`✗ Inspect failed: ${err.message}`);
  process.exit(1);
}
