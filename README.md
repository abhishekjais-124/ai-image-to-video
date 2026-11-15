# AI Image-to-Video Studio (Fact Shorts Edition)

Convert static images into **3–5 second cinematic 1080p+ video clips at a locked 30.000 FPS Constant Frame Rate (`.mp4`)** (`9:16 Vertical Shorts` & `16:9 Widescreen`) at **$0 cost** with **zero external API keys** and **zero npm dependencies**.

**v2.0.0 — cinematic quality engine.** Every clip is now directed, measured and verified:

- **Shot timeline from the text.** The caption/narration text (English, हिन्दी or Hinglish) is split into phrases; shots cut on phrase boundaries, with a hook → build → payoff structure, varied shot types (establishing, push-in, close-up, pan, reveal, hold) and clean cuts by default (at most one soft transition per clip).
- **Saliency-safe camera.** The subject's bounding box is measured from the image; every move is solved so the subject stays visible above the captions, the view never leaves the image, and motion is mathematically smooth (no random shake).
- **Controlled light and effects.** Effects are drawn on their own layer with normal alpha (never additive) and their opacity is measured against the clean image and held inside exposure limits — a light effect cannot wash out the frame.
- **Phrase captions.** Bold, outlined, at most two lines, inside the Shorts safe zone, with correct Devanagari shaping. Per-word highlighting is only used when real word timestamps are supplied; otherwise timing is estimated from the text and labelled as such.
- **Verified exports.** Every MP4 is decoded back frame by frame before it is reported as good; a quality report (`.qa.json`) is saved next to each video.
- **Automatic targeted repair.** Weak shots are repaired and only the affected shot is re-rendered (encoded shots are cached); attempts are capped and a repair is never kept if it made things worse.

There is **no audio**: clips are silent and nothing in this project transcribes or analyses sound. See [Limits](#limits).

**v1.5.0 — natural character movement + Cinematic Natural render:** the presenter now moves like a person (see below), and export has a slow, high-quality mode that uses the full 2–5 minute budget for one 3s clip.

**v1.4.0 — real character movement:** a flat image on its own can only be moved by the camera, so the studio now draws a procedural flat-2D presenter in front of the image who **walks in, points at the subject, talks/gestures, blinks, and reacts** — with legs, arms, head and mouth all animated as a pure function of time at 30 FPS. You can also upload your own character as a transparent-PNG cutout and it walks instead. See [Character movement](#character-movement) below.

Designed to run identically in **Antigravity**, **Claude Desktop**, **Codex**, or any modern browser.

---

## Core Specifications

| Spec | Value |
| :--- | :--- |
| **Frame Rate** | **30.000 FPS Constant Frame Rate (CFR)** (`timescale=30000, delta=1000`) |
| **Minimum Resolution** | **1080p Full HD** (`1080×1920` for 9:16 Shorts, `1920×1080` for 16:9) |
| **Optional Upgrade** | **1440p QHD** (`1440×2560` / `2560×1440`) |
| **Clip Durations** | **3s** (90 frames), **4s** (120 frames), **5s** (150 frames) |
| **Video Codec** | **H.264 (`avc1`) FastStart `.mp4`** via WebCodecs + In-House ISO-BMFF Muxer |
| **API Keys Required** | **None ($0 / 100% In-House & Offline)** |

---

## Quick Start

### 1. Start the Studio Web UI
```bash
npm start
# Opens at http://localhost:3000
```

### 2. Generate Scene Plans from CLI (Antigravity / Claude Desktop / Codex)
```bash
npm run generate -- --image media/samples/sample-ancient-pyramid.svg --model viral-hook-v1 --seed 2 --prompt "dramatic zoom with embers"
```

### 3. Render without opening the UI
Runs the real browser pipeline in headless Chrome (uses the Chrome/Edge/Brave already installed — no npm packages, no downloads):
```bash
# From an image (saliency is measured from its pixels)
npm run render -- --image media/samples/sample-ancient-pyramid.svg --model viral-hook-v1 --duration 5 --quality cinematic \
  --title "DID YOU KNOW?" --subtitle "Nobody knows how it was built. But the Great Pyramid aligns with true north almost perfectly!"

# Hindi / Hinglish work the same way
npm run render -- --model cinematic-doc-v1 --title "क्या आप जानते हैं?" --subtitle "गीज़ा का महान पिरामिड आज भी एक रहस्य है।"

# From a saved scene plan
npm run render -- --scene media/generated-code/my-scene.json

npm run render -- --help
```
Writes `media/outputs/<name>.mp4` and `media/outputs/<name>.qa.json`. Exit code 2 means the quality check found errors.
A default-named output never replaces an earlier render (it is saved as `-v2`, `-v3`, …); `--out <name>` reuses that name.

### 4. Inspect any MP4
```bash
npm run inspect -- path/to/clip.mp4              # container, full decode, brightness / motion checks
npm run inspect -- path/to/clip.mp4 --frames /tmp/frames --json
```

### 5. Tests
```bash
npm test            # unit tests (Node only)
npm run test:e2e    # renders real clips in headless Chrome, decodes and checks them
```

---

## Character movement

A single flat image cannot move its own limbs — that is a hard limit of
image-to-video from one layer, not a bug. The studio works around it
two ways, both deterministic at 30 FPS (preview === export):

1. **Drawn presenter (default, on)** — `src/engine/character.js` draws a
   flat-2D cartoon presenter who walks in from the side (0–28% of the
   clip), points at the detected subject and talks (28–72%), then reacts
   with a hop and raised arms (72–100%). Legs step, arms swing/point/
   gesture, the head tilts, eyes blink every ~2.7s, and the mouth opens
   while talking. Actions: `walk-point`, `explain`, `wave-react`
   (sidebar → Character, or `--character <id>` / `--no-character` on the CLI).
2. **Your own cutout** — upload a transparent PNG in the sidebar
   (Character → Upload character cutout). The cutout becomes its own
   layer and walks, bobs, leans and hops independently of the background
   camera. A flat PNG still cannot articulate limbs; for articulated
   limbs use the drawn presenter.

Since v2.0.0 the presenter is placed automatically beside the detected
subject (never on top of it), scaled down when the subject is wide, and
stands above the captions. The quality check disables it only if no
position keeps the subject clear.

### Natural motion (v1.5.0)
The presenter is animated with the same principles as hand-drawn
animation, all deterministic at 30 FPS:
- **Slow in / slow out:** the walk-in uses smoothstep (peak 1.5×
  average speed — cubic ease-in-out peaked at 3× and read as a dash),
  starts just off the edge so he is visible from the first frames.
- **Anticipation:** the pointing arm winds back before it launches,
  and he crouches before the reaction hop.
- **Follow-through:** the head lags the torso, the torso lags the hips;
  hair and shirt hem trail behind with their own lag.
- **Squash & stretch:** he squashes on landing and on the hop, then
  springs back. Feet lift along an arc while walking, never drag.
- **Talking:** the mouth opens in syllable bursts with pauses, not a
  metronome sine. Breathing and idle sway are layered sines, never a
  perfect loop. The camera has a gentle layered handheld drift.
- **Cinematic Natural render (default):** 4 sub-renders per frame over
  a half-frame shutter (real motion blur — a full-frame shutter ghosted
  him into 4 copies) at 1440p, accumulated and downscaled to 1080p,
  20 Mbps. Sub-samples never cross a cut. Several times the work of
  Fast mode (one render per frame); how long that takes depends on the
  browser — with GPU canvas a 3s clip is a few seconds either way. During either render the stage shows every
  frame live as it is encoded, with phase, frame, elapsed time, ETA
  and the current story beat (Walk in · Point & talk · React).

## Quality report and automatic repair

After every render the MP4 is decoded and each frame is measured. The report lists, per scene (shot): its time range, issues, severity, suggested correction, what was corrected, and whether the correction was validated by the re-render.

- **Objective** checks are hard pass/fail facts: container structure, every frame decodes, frame count, constant 30 fps, timestamps, colour tag matches the stream, captions inside the safe zone, camera inside the image.
- **Heuristic** checks are measurements judged against tuned thresholds: wash-out against the clean image, brightness flashes, frozen picture, motion jitter, caption contrast, subject visibility, pacing. They are estimates, and are labelled as such.
- **Not evaluated** (listed in every report): semantic relevance of visuals to the text, face visibility, anything about audio.

| Detected problem | Automatic action |
| :--- | :--- |
| Effects wash out the picture / hide the subject | Lower the effects layer opacity for that shot (scaled to the measured excess) |
| Captions hard to read | Stronger backdrop (none → scrim → card) |
| Camera crops the subject / captions sit on it | Widen that shot's framing |
| Presenter covers the subject | Shrink the presenter, then disable it |
| Motion jitter / camera jerk | Remove sway and emphasis punch |
| Frozen picture | Increase camera travel in that shot |
| Flash or jump at a soft transition | Replace it with a clean cut |
| Corrupt / undecodable frames, wrong frame count | Re-encode without the cache |

Only the affected shot is re-rendered; other shots are reused from the segment cache. At most 2 repair renders per clip, at most 2 attempts per issue, and the best attempt is kept.

## Scene plan fields (schema 2.0)

Plans saved by earlier versions (schema 1.0) still load and render as one manual camera move.

| Field | Meaning |
| :--- | :--- |
| `cameraMode` | `"director"` (shot timeline, default for new plans) or `"manual"` (classic `zoomStart/zoomEnd/panX/panY/rotateDeg`) |
| `timeline` | Caption cues, shots (`type`, `start`, `end`, `easing`, `transitionIn`), beats. Re-planned automatically when the text or duration changes. A shot may pin `from` / `to` framings (`u`, `v`, `zoom`). |
| `captionMode` | `"phrases"` (default) or `"static"` (one fixed card) |
| `captionStyle` | `{ backdrop: "auto"\|"none"\|"scrim"\|"card", sizeScale, accentColor, safeBottom, safeSide }` |
| `effectIntensity` | 0–1.5 master strength for light/atmosphere (default 1) |
| `exposureLimits` | Override the effect limits (`maxLumaGain`, `maxClipGain`, `maxSubjectLumaShift`, `minSubjectContrast`, `maxLumaLoss`) |
| `wordTimings` | `[{ start, end }]` per word (seconds). Supplying them switches captions to real per-word sync. |
| `shotOverrides` | Per-shot changes written by the repair loop (`fxGain`, `zoomScale`, `motionScale`, `handheld`, `transitionIn`) |
| `handheld`, `beatPunch`, `beatGlow`, `warmth` | Optional motion/grade controls |

## Limits

- **No audio.** There is no audio input, music, sound design, transcription or audio sync in this project. Output is silent video; add narration in an editor. Caption timing is estimated from the text unless `wordTimings` are supplied.
- **One image per clip, 3–5 seconds.** "Scenes" are shots — different framings of the same image.
- **No depth separation inside the image.** Parallax is real for the layers the engine draws itself (dust, fog, light, presenter, captions); the photo is a flat plane. No segmentation/depth model is bundled, by design (nothing to download, no paid service).
- **Scene understanding is lexical** (keywords, emphasis, pauses), not a language or vision model.
- Rendering needs a Chromium-family browser with WebCodecs H.264. Without it the UI falls back to a real-time recording that is not frame-accurate and is reported as such.

## In-House Models & Visual Presets

### 5 Selectable In-House Director Models (`src/models/inhouse-models.js`)
Each model analyzes the source image's pixel contrast, luminance, and color warmth, then generates both a **Scene Plan JSON** and a **bespoke Custom Canvas 2D VFX layer**:
1. **In-House Saliency Vision v1 (`saliency-vision`)** — Auto-detects the subject focal point `(focusX, focusY)` and renders a soft anamorphic focal glow.
2. **Viral Shorts Hook Director (`viral-hook-v1`)** — Fast push-in hook, animated subject focus ring, and top retention progress bar.
3. **Cinematic Documentary Master (`cinematic-doc-v1`)** — Tripod-style pull-back reveal with documentary viewfinder marks and warm grading.
4. **Mystery & True-Crime Director (`mystery-noir-v1`)** — Handheld documentary sway, atmospheric rain streaks, and shadow pulses.
5. **Sci-Fi Neural Director (`scifi-neural-v1`)** — Cyber glitch slices, scanline laser, and animated target telemetry locked onto the focal point.

### 5 Deterministic Fact-Short Presets (`src/presets/fact-presets.js`)
- 📽️ **Documentary Ken Burns + Dust** (`documentary-kenburns`)
- ✨ **3D Perspective Tilt + Spotlight** (`3d-perspective-tilt`)
- 🌫️ **Mystery Fog + Handheld Pulse** (`mystery-fog-shake`)
- ⚡ **Sci-Fi Cyber Grid + Glitch** (`scifi-cyber-glitch`)
- 🎞️ **Vintage Film Grain + Light Leaks** (`vintage-film-grain`)

---

## Project Folder Structure

```text
ai-image-to-video/
├── media/
│   ├── inputs/           # Source images uploaded for conversion (git-ignored)
│   ├── generated-code/   # Saved Scene Plan JSON & custom animation code per clip
│   ├── outputs/          # Rendered 1080p+ 30.000 FPS (3-5s) H.264 .mp4 files
│   └── samples/          # Built-in 9:16 vector test images for Fact Shorts
├── src/
│   ├── engine/
│   │   ├── director.js           # Text → timeline: phrases, shots, transitions, beats (EN / HI / Hinglish)
│   │   ├── camera.js             # Framings, bounds-safe camera, eased shot moves (pure math)
│   │   ├── captions.js           # Caption layout (safe zone, 2 lines, Devanagari-safe) + drawing
│   │   ├── character.js          # Procedural presenter + cutout layer, placed beside the subject
│   │   ├── renderer.js           # prepareScene (probes, exposure limits) + layered frame renderer
│   │   ├── frame-metrics.js      # Pixel metrics shared by the exposure guard and the inspector
│   │   ├── mp4-muxer.js          # ISO-BMFF H.264 muxer, structural demuxer, decode verifier
│   │   ├── exporter.js           # Per-shot WebCodecs encode with segment cache + verification
│   │   ├── quality-inspector.js  # Frame analysis, quality report, repair proposals
│   │   └── pipeline.js           # Pre-flight → render → inspect → repair → validate
│   ├── headless.html / .js       # Scriptable entry point (window.studio) for the CLI and tests
│   ├── presets/
│   │   └── fact-presets.js   # All 5 Fact-Short presets (Dust, Spotlight, Fog, Glitch, Film)
│   ├── models/
│   │   └── inhouse-models.js # Keyless pixel saliency analyzer, prompt parser & 5 models
│   ├── ui/
│   │   └── app.js            # Studio UI controller, live code editor & batch queue
│   └── index.html            # Studio Web Application
├── scripts/
│   ├── generate-scene.js # CLI Scene Plan generator for Antigravity / Claude / Codex
│   ├── render.js         # Headless render: plan/image → MP4 + quality report
│   ├── inspect.js        # Inspect any MP4 (container, decode, heuristics)
│   ├── lib/headless-chrome.js # Zero-dependency Chrome DevTools driver
│   └── sync-github.sh    # 1-command GitHub commit & push helper
├── tests/                # unit/ (Node) and e2e/ (headless Chrome renders)
├── AGENTS.md             # Instructions for Antigravity, Claude Desktop, and Codex
├── CLAUDE.md             # Pointer for Claude Desktop / Claude Code
├── server.js             # Hardened zero-dependency local ES module Node server
└── package.json
```
