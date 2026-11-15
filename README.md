# AI Image-to-Video Studio (Fact Shorts Edition)

Convert static images into **3–5 second cinematic 1080p+ video clips at a locked 30.000 FPS Constant Frame Rate (`.mp4`)** (`9:16 Vertical Shorts` & `16:9 Widescreen`) at **$0 cost** with **zero external API keys** and **zero npm dependencies**.

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
