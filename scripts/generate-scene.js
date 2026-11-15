#!/usr/bin/env node
// CLI Scene Plan Generator for Antigravity, Claude Desktop, and Codex
// Usage:
//   node scripts/generate-scene.js --image media/samples/sample-ancient-pyramid.svg --model viral-hook-v1 --duration 4

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenePlan, INHOUSE_MODELS } from '../src/models/inhouse-models.js';
import { FACT_PRESETS } from '../src/presets/fact-presets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.log(`
🎬 AI Image-to-Video CLI Scene Generator (1080p+ / 30 FPS)
Compatible with Antigravity, Claude Desktop, and Codex.

Options:
  --image <path>       Source image path (default: media/samples/sample-ancient-pyramid.svg)
  --model <id>         In-house model (${INHOUSE_MODELS.map((m) => m.id).join(', ')})
  --preset <id>        Preset (${FACT_PRESETS.map((p) => p.id).join(', ')})
  --aspect <ratio>     9:16 or 16:9 (default: 9:16)
  --resolution <res>   1080p or 1440p (default: 1080p)
  --duration <sec>     3, 4, or 5 (default: 4)
  --seed <num>         Variation seed integer (default: 1)
  --prompt <text>      Motion/vibe direction prompt
  --title <text>       Fact headline
  --subtitle <text>    Fact subtitle
  --out <name>         Output filename stem in media/generated-code/
`);
  process.exit(0);
}

const imagePath = args.image || '/media/samples/sample-ancient-pyramid.svg';
const modelId = args.model || 'saliency-vision';
const presetId = args.preset || 'documentary-kenburns';
const aspectRatio = args.aspect === '16:9' ? '16:9' : '9:16';
const resolution = args.resolution === '1440p' ? '1440p' : '1080p';
const duration = [3, 4, 5].includes(Number(args.duration)) ? Number(args.duration) : 4;
const variationSeed = Number(args.seed) || 1;
const motionPrompt = args.prompt || '';
const factTitle = args.title ?? 'DID YOU KNOW?';
const factSubtitle =
  args.subtitle ??
  'The Great Pyramid of Giza aligns with true north within 3/60th of a single degree.';

const plan = buildScenePlan({
  img: null,
  modelId,
  presetId,
  aspectRatio,
  resolution,
  duration,
  factTitle,
  factSubtitle,
  motionPrompt,
  variationSeed,
  autoSelectPreset: !args.preset
});

plan.imageSrc = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;

const stem = (
  args.out ||
  `${path.basename(imagePath, path.extname(imagePath))}-${modelId}-seed${variationSeed}`
)
  .replace(/[^a-zA-Z0-9_-]/g, '-')
  .replace(/-+/g, '-');

const outDir = path.join(ROOT, 'media', 'generated-code');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${stem}.json`);

fs.writeFileSync(outFile, JSON.stringify(plan, null, 2), 'utf8');
console.log(`✓ Generated Scene Plan saved to: media/generated-code/${stem}.json`);
console.log(
  `  • Model: ${plan.modelId} (Seed #${plan.variationSeed}) | Preset: ${plan.presetId} | ${plan.aspectRatio} ${plan.resolution} @ ${plan.fps} FPS (${plan.totalFrames} frames)`
);
