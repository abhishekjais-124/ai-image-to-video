# Agent Instructions (Antigravity • Claude Desktop • Codex)

This project is a **100% In-House, Zero-API-Key AI Image-to-Video Studio** built for creating **Fact Video Shorts** (`9:16` Vertical and `16:9` Widescreen).

## Hard Output Constraints
- **Frame Rate:** Strictly **30.000 FPS Constant Frame Rate (CFR)** (`FIXED_FPS = 30` in `src/presets/fact-presets.js`). Never use 60 FPS or variable frame rate.
- **Resolution Floor:** Minimum **1080p** (`1080×1920` for `9:16` Shorts, `1920×1080` for `16:9` Widescreen; `1440p` QHD optional). 720p is not supported.
- **Duration:** `3s` (90 frames), `4s` (120 frames), or `5s` (150 frames).
- **Container & Codec:** FastStart ISO-BMFF `.mp4` (`H.264 / avc1`) muxed via `src/engine/mp4-muxer.js` and saved to `media/outputs/`.
- **Zero External API Keys:** Never require `GEMINI_API_KEY`, `OPENAI_API_KEY`, or any external paid/cloud token. All visual analysis and scene generation run in-house or via the active coding agent (`Antigravity`, `Claude Desktop`, or `Codex`).

## How Agents Can Generate Custom Scene Plans
When a user asks you (in Antigravity, Claude Desktop, or Codex) to direct a clip from an image in `media/inputs/` or `media/samples/`:
1. **Option A (CLI Generator):** Run:
   ```bash
   npm run generate -- --image media/samples/sample-ancient-pyramid.svg --model viral-hook-v1 --seed 2 --prompt "dramatic zoom with embers" --title "DID YOU KNOW?" --subtitle "Your concise fact here."
   ```
2. **Option B (Direct Agent Authoring):** Inspect the image visually and write a Scene Plan JSON file into `media/generated-code/<name>.json` with both camera parameters (`zoomStart`, `zoomEnd`, `panX`, `panY`, `focusX`, `focusY`, `presetId`) and custom Canvas 2D VFX code (`generatedCustomCode`).
3. Start the studio server with `npm start` (`node server.js` on `http://localhost:3000`), select the generated scene from the **📂 Load Saved / Agent Scene** dropdown, and click **Export 1080p 30FPS .MP4**.
