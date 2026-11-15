# AI Image-to-Video Studio (Fact Shorts Edition)

Convert static images into **3–5 second cinematic 1080p+ video clips at a locked 30 FPS** (`9:16 Vertical Shorts` & `16:9 Widescreen`) at **$0 cost** with **zero external API keys**.

Designed to run identically in **Antigravity**, **Claude Desktop**, **Codex**, or any modern browser.

---

## Core Specifications

| Spec | Value |
| :--- | :--- |
| **Frame Rate** | **30 FPS (Constant Frame Rate)** |
| **Minimum Resolution** | **1080p Full HD** (`1080×1920` for 9:16 Shorts, `1920×1080` for 16:9) |
| **Optional Upgrade** | **1440p QHD** (`1440×2560` / `2560×1440`) |
| **Clip Durations** | **3s** (90 frames), **4s** (120 frames), **5s** (150 frames) |
| **API Keys Required** | **None ($0 / 100% In-House)** |

---

## Quick Start

```bash
npm start
# Studio runs at http://localhost:3000
```

---

## Project Folder Structure

```text
ai-image-to-video/
├── media/
│   ├── inputs/           # Source images uploaded for conversion (git-ignored)
│   ├── generated-code/   # Saved Scene Plan JSON & custom animation code per clip
│   ├── outputs/          # Rendered 1080p+ 30 FPS (3-5s) video files
│   └── samples/          # Built-in 9:16 vector test images for Fact Shorts
├── src/
│   ├── engine/
│   │   └── renderer.js       # Cover-fit, word-wrapped, 30 FPS deterministic renderer
│   ├── presets/
│   │   └── fact-presets.js   # All 5 Fact-Short presets (Dust, Spotlight, Fog, Glitch, Film)
│   ├── models/
│   │   └── inhouse-models.js # Keyless pixel saliency analyzer & scene directors
│   ├── ui/
│   │   └── app.js            # Studio UI controller & live code editor
│   └── index.html            # Studio Web Application
├── scripts/
│   └── sync-github.sh    # 1-command GitHub commit & push helper
├── AGENTS.md             # Instructions for Antigravity, Claude Desktop, and Codex
├── CLAUDE.md             # Pointer for Claude Desktop / Claude Code
├── server.js             # Hardened zero-dependency local Node server
└── package.json
```
