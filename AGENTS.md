# Agent Instructions (Antigravity • Claude Desktop • Codex)

This project is a **100% In-House, Zero-API-Key AI Image-to-Video Studio** built for creating **Fact Video Shorts** (`9:16` Vertical and `16:9` Widescreen).

## Hard Output Constraints
- **Frame Rate:** Strictly **30 FPS** (`FIXED_FPS = 30` in `src/presets/fact-presets.js`). Never use 60 FPS or variable frame rate.
- **Resolution Floor:** Minimum **1080p** (`1080×1920` for `9:16` Shorts, `1920×1080` for `16:9` Widescreen; `1440p` QHD optional). 720p is not supported.
- **Duration:** `3s` (90 frames), `4s` (120 frames), or `5s` (150 frames).
- **Zero External API Keys:** Never require `GEMINI_API_KEY`, `OPENAI_API_KEY`, or any external paid/cloud token. All visual analysis and scene generation run in-house or via the active coding agent (`Antigravity`, `Claude Desktop`, or `Codex`).

## How Agents Can Generate Custom Scene Plans
When a user asks you (in Antigravity, Claude Desktop, or Codex) to direct a clip from an image in `media/inputs/` or `media/samples/`:
1. Inspect the image visually (using your built-in file reader) or use `src/models/inhouse-models.js`.
2. Write a Scene Plan JSON file into `media/generated-code/<name>.json` matching this schema:
   ```json
   {
     "schemaVersion": "1.0",
     "engine": "inhouse-30fps-1080p",
     "modelId": "agent-custom",
     "presetId": "documentary-kenburns",
     "aspectRatio": "9:16",
     "resolution": "1080p",
     "fps": 30,
     "duration": 4,
     "totalFrames": 120,
     "focusX": 0.5,
     "focusY": 0.42,
     "zoomStart": 1.03,
     "zoomEnd": 1.18,
     "panX": -0.02,
     "panY": -0.03,
     "rotateDeg": 0.5,
     "particleCount": 65,
     "vignetteStrength": 0.75,
     "accentColor": "255, 225, 155",
     "titleColor": "#ffd166",
     "factTitle": "DID YOU KNOW?",
     "factSubtitle": "Your concise fact subtitle here."
   }
   ```
3. Start the studio server with `npm start` (`node server.js` on `http://localhost:3000`).
