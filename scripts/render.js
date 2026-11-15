#!/usr/bin/env node
// Unattended render: scene plan → MP4 + quality report, using the studio's real
// browser pipeline in headless Chrome (no npm dependencies, no paid services).
//
//   npm run render -- --scene media/generated-code/my-scene.json
//   npm run render -- --image media/samples/sample-ancient-pyramid.svg --model saliency-vision --seed 2 --duration 3
//
// Writes media/outputs/<name>.mp4 and media/outputs/<name>.qa.json.

import fs from 'node:fs';
import path from 'node:path';
import { withStudioPage, PROJECT_ROOT } from './lib/headless-chrome.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.log(`
Render a clip without opening the studio UI.

Source (one of):
  --scene <file.json>     A saved scene plan (from the UI, or npm run generate)
  --image <path>          Build a plan from an image (saliency is measured from its pixels)

Plan options (with --image):
  --model <id>            saliency-vision | viral-hook-v1 | cinematic-doc-v1 | mystery-noir-v1 | scifi-neural-v1
  --preset <id>           Visual preset (default: the model's own)
  --seed <n>              Variation seed (default 1)
  --duration <3|4|5>      Seconds (default 4)
  --aspect <9:16|16:9>    (default 9:16)
  --title <text>          Headline chip
  --subtitle <text>       Narration / caption text (English, Hindi or Hinglish)
  --prompt <text>         Motion direction, e.g. "slow pull back"
  --no-character          Disable the presenter
  --effects <0..1.5>      Effect intensity (default 1)
  --captions <phrases|static>

Render options:
  --quality <fast|cinematic>   (default fast)
  --out <name>                 Output file stem in media/outputs/ (replaces a file of that name)
  --overwrite                  Replace an existing default-named output instead of saving -v2, -v3, …
  --no-repair                  Skip automatic repair
  --attempts <n>               Max repair re-renders (default 2)
  --json                       Print the full quality report as JSON
`);
  process.exit(0);
}

const toUrlPath = (p) => {
  const abs = path.resolve(PROJECT_ROOT, p.replace(/^\//, ''));
  if (!abs.startsWith(PROJECT_ROOT + path.sep)) {
    throw new Error(`"${p}" is outside the project. Copy the image into media/inputs/ first.`);
  }
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
  return '/' + path.relative(PROJECT_ROOT, abs).split(path.sep).join('/');
};

function summarise(report) {
  const lines = [];
  const s = report.summary;
  lines.push(`Quality: ${s.status.toUpperCase()}  score ${s.score}/100  (${s.errors} errors, ${s.warnings} warnings, ${s.notes} notes)`);
  const c = report.objective.container;
  if (c) {
    lines.push(`File: ${c.width}×${c.height}, ${c.fps} fps ${c.constantFrameRate ? 'CFR' : 'VFR'}, ${c.frameCount} frames, ${c.durationSec}s, ${(c.sizeBytes / 1048576).toFixed(2)} MB, ${c.codec}`);
  }
  const d = report.objective.decode;
  if (d) lines.push(`Decode: ${d.decodedFrames}/${d.expectedFrames} frames${d.errors.length ? ` — ${d.errors.join('; ')}` : ' — no errors'}`);
  const print = (it, where) => {
    const fix = it.correction.status === 'applied' ? ` [fixed: ${it.correction.action}; ${it.validation}]` : '';
    lines.push(`  ${it.severity.toUpperCase().padEnd(7)} ${where.padEnd(7)} (${it.kind}) ${it.message}${fix}`);
  };
  report.video.issues.forEach((it) => print(it, 'video'));
  for (const scene of report.scenes) {
    lines.push(`Scene ${scene.id}: ${scene.type}, ${scene.range.start.toFixed(2)}–${scene.range.end.toFixed(2)}s, in: ${scene.transitionIn}, effects ${(scene.effectsOpacity * 100).toFixed(0)}%${scene.renderedFromCache ? ', reused from cache' : ''}`);
    scene.issues.forEach((it) => print(it, scene.id));
  }
  return lines.join('\n');
}

try {
  const startedAt = Date.now();
  const out = await withStudioPage('/src/headless.html', async (page) => {
    let plan;
    if (args.scene) {
      plan = JSON.parse(fs.readFileSync(path.resolve(PROJECT_ROOT, args.scene), 'utf8'));
      if (!plan.imageSrc) throw new Error('The scene plan has no imageSrc.');
      if (!plan.imageSrc.startsWith('data:')) plan.imageSrc = toUrlPath(plan.imageSrc);
    } else {
      const imageSrc = toUrlPath(args.image || 'media/samples/sample-ancient-pyramid.svg');
      const options = {
        imageSrc,
        modelId: args.model || 'saliency-vision',
        presetId: args.preset || 'documentary-kenburns',
        autoSelectPreset: !args.preset,
        aspectRatio: args.aspect === '16:9' ? '16:9' : '9:16',
        resolution: '1080p',
        duration: [3, 4, 5].includes(Number(args.duration)) ? Number(args.duration) : 4,
        variationSeed: Number(args.seed) || 1,
        motionPrompt: args.prompt || '',
        factTitle: args.title ?? 'DID YOU KNOW?',
        factSubtitle: args.subtitle ?? 'The Great Pyramid of Giza aligns with true north within 3/60th of a single degree.',
        characterEnabled: !args['no-character'],
        effectIntensity: args.effects !== undefined ? Number(args.effects) : 1,
        captionMode: args.captions === 'static' ? 'static' : 'phrases'
      };
      plan = await page.evaluate(`window.studio.buildPlan(${JSON.stringify(options)})`);
    }

    const stem = (args.out || `${path.basename(plan.imageSrc, path.extname(plan.imageSrc))}-${plan.modelId || 'scene'}-s${plan.variationSeed ?? 1}-${String(plan.aspectRatio || '9:16').replace(':', 'x')}-1080p-30fps`)
      .replace(/[^a-zA-Z0-9_-]/g, '-');

    const request = {
      plan,
      quality: args.quality === 'cinematic' ? 'cinematic' : 'fast',
      autoRepair: !args['no-repair'],
      maxRepairAttempts: args.attempts !== undefined ? Number(args.attempts) : 2,
      saveAs: stem,
      // An explicit --out name is the caller's to reuse; default names never replace an earlier render.
      overwrite: Boolean(args.out) || Boolean(args.overwrite)
    };
    return page.evaluate(`window.studio.render(${JSON.stringify(request)})`, { timeoutMs: 900_000 });
  });

  if (args.json) {
    console.log(JSON.stringify(out.report, null, 2));
  } else {
    console.log(summarise(out.report));
    for (const entry of out.report.repairs?.log || []) {
      for (const a of entry.actions) console.log(`Repair (${entry.stage}): ${a.code}${a.scene ? ` @ ${a.scene}` : ''} → ${a.action}${a.validation ? ` [${a.validation}]` : ''}`);
    }
    out.attempts.forEach((a) =>
      console.log(`Render ${a.attempt}: score ${a.score}, rendered [${a.renderedShots.join(', ') || '—'}], reused [${a.reusedShots.join(', ') || '—'}], ${a.totalMs} ms`)
    );
  }
  if (out.saved?.ok) console.log(`\n✓ Video:  media/outputs/${out.saved.fileName}`);
  if (out.savedReport?.ok) console.log(`✓ Report: media/outputs/${out.savedReport.fileName}`);
  console.log(`Total: ${((Date.now() - startedAt) / 1000).toFixed(1)}s (encoder path: ${out.path})`);
  process.exit(out.report.summary.errors > 0 ? 2 : 0);
} catch (err) {
  console.error(`✗ Render failed: ${err.message}`);
  process.exit(1);
}
