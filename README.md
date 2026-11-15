# AI Image-to-Video Studio (Fact Shorts Edition)

Convert static images into **3–5 second cinematic 720p / 1080p video clips** (`9:16 Vertical Shorts` & `16:9 Widescreen`) at **$0 cost** using **AI Code-Driven Animation (`.html` / `.css` / `.tsx` / `WebGL Canvas`)** — no local GPU hardware required.

---

## Project Folder Structure

```text
ai-image-to-video/
├── media/
│   ├── inputs/           # Source images uploaded for conversion (git-ignored)
│   ├── generated-code/   # AI-written .html / .css / .tsx animation code per clip
│   ├── outputs/          # Rendered 720p & 1080p (3-5s) video files ready for editing
│   └── samples/          # Built-in sample images for testing Fact Short presets
├── public/
│   └── overlays/         # Film grain, atmospheric textures, LUTs
├── src/
│   ├── ai/               # AI Scene Director (Prompt/Vision -> Code generator)
│   ├── engine/           # 720p/1080p Canvas/WebGL/CSS/TSX execution & video recorder
│   ├── presets/          # Fact-Short cinematic templates (Ken Burns, 3D Tilt, Fog, Glitch, Spotlight)
│   └── components/       # Studio UI (Batch Uploader, Live 1080p Stage, Live Code Editor)
├── scripts/              # Helper CLI & GitHub sync scripts
├── .env.example          # Optional free AI API keys configuration
└── README.md             # Project documentation
```
