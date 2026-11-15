# Agent Instructions (Antigravity • Claude Desktop • Codex)

This project is a **100% In-House, Zero-API-Key AI Image-to-Video Studio** built for creating **Fact Video Shorts** (`9:16` Vertical and `16:9` Widescreen).

## Hard Output Constraints
- **Frame Rate:** Strictly **30.000 FPS Constant Frame Rate (CFR)** (`FIXED_FPS = 30` in `src/presets/fact-presets.js`). Never use 60 FPS or variable frame rate.
- **Resolution Floor:** Minimum **1080p** (`1080×1920` for `9:16` Shorts, `1920×1080` for `16:9` Widescreen; `1440p` QHD optional). 720p is not supported.
- **Duration:** `3s` (90 frames), `4s` (120 frames), or `5s` (150 frames).
- **Container & Codec:** FastStart ISO-BMFF `.mp4` (`H.264 / avc1`) muxed via `src/engine/mp4-muxer.js` and saved to `media/outputs/`.
- **Zero External API Keys:** Never require `GEMINI_API_KEY`, `OPENAI_API_KEY`, or any external paid/cloud token. All visual analysis and scene generation run in-house or via the active coding agent (`Antigravity`, `Claude Desktop`, or `Codex`).

## Character movement (v1.4.0)
- A flat image cannot move its own limbs. Never claim the image's own
  subject is animated. The moving subject is the procedural presenter
  (`src/engine/character.js`, drawn in front of the image) or a user
  cutout PNG (its own layer, walk/bob/lean/hop only).
- Presenter timeline (deterministic, pure function of `t`): walk-in
  0–34%, point/explain/talk 34–74%, react/hop 74–100%. Actions:
  `walk-point` (default), `explain`, `wave-react`. Toggle with
  `characterEnabled`, choose with `characterAction` in the Scene Plan.
- Manual camera (`cameraMode: "manual"`, and all schema 1.0 plans): zoom
  1.00→1.30, pan ~±0.06, easing blends 30% linear so motion is visible
  from frame 1. Do not revert to the old 1.02→1.18 pure ease-in-out —
  that is why the first second looked frozen.
- The presenter is placed by `planCharacterPlacement` beside the subject
  box and above the captions. Never hard-code a standing position on the
  subject.
- Natural motion (v1.5.0): smoothstep walk-in (cubic ease-in-out peaks
  at 3x speed and looks like a dash), anticipation before the point and
  the hop, head/torso/hem lag, squash on landing, foot lift on arcs.
- Cinematic Natural render: 4 sub-renders per frame, HALF-frame
  shutter, 1440p, additive ('lighter') accumulation of the 4 sub-frames
  onto a canvas that is cleared to black FIRST — plain alpha blending
  converges to 1 - 0.75^4 = 0.68 and darkens every frame by 32%;
  accumulating without the clear adds every frame onto the last and
  washes the clip out to white (that is what broke the seed-2 pyramid
  sample). `npm run test:e2e` checks cinematic brightness against fast.

## Engine rules (v2.0.0)
- **Director timeline** (`src/engine/director.js`): new plans have
  `cameraMode: "director"` and a `timeline` (cues, shots, beats) planned
  from the caption text. Shots cut on phrase boundaries; default
  transition is a clean cut; never two identical shot types in a row.
- **Camera** (`src/engine/camera.js`): moves are interpolated between
  bounds-safe framings. Never add per-frame random offsets (jitter) or
  unconditional shake; sway is opt-in (`handheld`) and smooth.
- **Effects** (`src/presets/fact-presets.js`, custom scene code): drawn
  on a separate layer with normal alpha and composited at a measured
  opacity (`prepareScene` probes). Do not use `'lighter'`/additive
  blending for effects, and do not bypass the layer.
- **Captions** (`src/engine/captions.js`): words are measured and drawn
  whole (Devanagari shaping), max two lines, inside the safe zone.
  Per-word highlight only when `timeline.timingSource === "aligned"`.
- **Muxer** (`src/engine/mp4-muxer.js`): WebCodecs output is AVCC — never
  sniff for Annex-B start codes on it (an AVCC NAL of 256–511 bytes
  starts `00 00 01`). The `colr` tag must match the bitstream.
- **No audio pipeline exists.** Do not report audio problems for these
  silent clips, and do not claim audio sync.
- **Testing.** `npm test` (unit) and `npm run test:e2e` (real renders in
  headless Chrome, decoded and measured). To check a clip by eye:
  `npm run inspect -- <file> --frames <dir>` and look at the frames.
  A file existing is not proof — only a full decode is.
- **Rendering from the CLI:** `npm run render -- --help`.

## How Agents Can Generate Custom Scene Plans
When a user asks you (in Antigravity, Claude Desktop, or Codex) to direct a clip from an image in `media/inputs/` or `media/samples/`:
1. **Option A (CLI Generator):** Run:
   ```bash
   npm run generate -- --image media/samples/sample-ancient-pyramid.svg --model viral-hook-v1 --seed 2 --prompt "dramatic zoom with embers" --title "DID YOU KNOW?" --subtitle "Your concise fact here."
   ```
2. **Option B (Direct Agent Authoring):** Inspect the image visually and write a Scene Plan JSON file into `media/generated-code/<name>.json` with both camera parameters (`zoomStart`, `zoomEnd`, `panX`, `panY`, `focusX`, `focusY`, `presetId`) and custom Canvas 2D VFX code (`generatedCustomCode`).
3. Render it: `npm run render -- --scene media/generated-code/<name>.json` (MP4 + quality report in `media/outputs/`), or start the studio server with `npm start` (`node server.js` on `http://localhost:3000`), select the generated scene from the **📂 Load Saved / Agent Scene** dropdown, and click **Export 1080p 30FPS .MP4**.
