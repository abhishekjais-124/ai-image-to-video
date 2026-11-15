# AI Image-to-Video Studio (Fact Shorts Edition)

Convert static images into **3–5 second cinematic 1080p+ video clips at a locked 30.000 FPS Constant Frame Rate (`.mp4`)** (`9:16 Vertical Shorts` & `16:9 Widescreen`) at **$0 cost** with **zero external API keys** and **zero npm dependencies**.

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

The camera was also made visibly faster in v1.4.0: zoom is now
1.00×→1.30× (was 1.02×→1.18×), pan is ~2× larger, and the ease curve
blends in 30% linear motion so the first second is no longer frozen.
Dust/fog/grain particles are 2× larger and brighter for the same reason.

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
  him into 4 copies) at 1440p, accumulated additively and downscaled
  to 1080p, 20 Mbps. ~6× the work of Fast mode: a 3s clip takes
  2–5 minutes. Fast mode (one render per frame, ~30s) is still there
  for checking a scene. During either render the stage shows every
  frame live as it is encoded, with phase, frame, elapsed time, ETA
  and the current story beat (Walk in · Point & talk · React).

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
│   │   ├── character.js      # Procedural presenter + cutout layer (walk/point/talk/react, 30 FPS)
│   │   ├── renderer.js       # Cover-fit, word-wrapped, 30 FPS deterministic renderer
│   │   ├── mp4-muxer.js      # Zero-dependency ISO-BMFF H.264 FastStart MP4 muxer & verifier
│   │   └── exporter.js       # Frame-by-frame WebCodecs H.264 encoder & batch pipeline
│   ├── presets/
│   │   └── fact-presets.js   # All 5 Fact-Short presets (Dust, Spotlight, Fog, Glitch, Film)
│   ├── models/
│   │   └── inhouse-models.js # Keyless pixel saliency analyzer, prompt parser & 5 models
│   ├── ui/
│   │   └── app.js            # Studio UI controller, live code editor & batch queue
│   └── index.html            # Studio Web Application
├── scripts/
│   ├── generate-scene.js # CLI Scene Plan generator for Antigravity / Claude / Codex
│   └── sync-github.sh    # 1-command GitHub commit & push helper
├── AGENTS.md             # Instructions for Antigravity, Claude Desktop, and Codex
├── CLAUDE.md             # Pointer for Claude Desktop / Claude Code
├── server.js             # Hardened zero-dependency local ES module Node server
└── package.json
```
