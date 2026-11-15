// Studio UI Controller (ES Module)
// Drives the 1080p+ / 30 FPS Canvas Stage, In-House Model Selector, and Live Code Editor.

import {
  FIXED_FPS,
  FACT_PRESETS,
  getResolutionDims
} from '../presets/fact-presets.js';
import {
  checkImageResolution,
  renderFrameAtTime
} from '../engine/renderer.js';
import {
  INHOUSE_MODELS,
  buildScenePlan
} from '../models/inhouse-models.js';

const state = {
  aspectRatio: '9:16',
  resolution: '1080p',
  duration: 4,
  modelId: 'saliency-vision',
  presetId: 'documentary-kenburns',
  imageSrc: '/media/samples/sample-ancient-pyramid.svg',
  imageName: 'sample-ancient-pyramid.svg',
  imgElement: null,
  factTitle: 'DID YOU KNOW?',
  factSubtitle:
    'The Great Pyramid of Giza aligns with true north within 3/60th of a single degree.',
  scenePlan: {},
  customCodeSource: `// Optional Custom Canvas 2D Overlay (runs at 30 FPS on every frame)
// Available args: ctx, { t, frame, fps, duration, progress, width, height, focusX, focusY }
`,
  customDrawFn: null,
  editorTab: 'json', // 'json' | 'js'
  isPlaying: true,
  currentFrame: 0,
  lastTickTime: 0
};

// DOM Elements
const stageCanvas = document.getElementById('stageCanvas');
const stageCtx = stageCanvas.getContext('2d');
const stageViewport = document.getElementById('stageViewport');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const imageFileNameEl = document.getElementById('imageFileName');
const sampleSelectEl = document.getElementById('selSample');
const resWarningBanner = document.getElementById('resWarningBanner');

const btnShorts = document.getElementById('btnShorts');
const btnLandscape = document.getElementById('btnLandscape');
const selResolution = document.getElementById('selResolution');
const selDuration = document.getElementById('selDuration');
const selModel = document.getElementById('selModel');
const modelDescEl = document.getElementById('modelDesc');
const selPreset = document.getElementById('selPreset');
const presetDescEl = document.getElementById('presetDesc');

const factTitleInput = document.getElementById('factTitle');
const factSubtitleInput = document.getElementById('factSubtitle');

const btnPlayPause = document.getElementById('btnPlayPause');
const frameScrubber = document.getElementById('frameScrubber');
const timelineReadout = document.getElementById('timelineReadout');
const specBadge = document.getElementById('specBadge');

const tabJsonBtn = document.getElementById('tabJsonBtn');
const tabJsBtn = document.getElementById('tabJsBtn');
const codeEditor = document.getElementById('codeEditor');
const editorStatus = document.getElementById('editorStatus');
const btnApplyCode = document.getElementById('btnApplyCode');
const btnSaveScene = document.getElementById('btnSaveScene');
const btnRegeneratePlan = document.getElementById('btnRegeneratePlan');

/**
 * Populate dropdowns from ES module registries
 */
function initDropdowns() {
  selModel.innerHTML = INHOUSE_MODELS.map(
    (m) => `<option value="${m.id}">${m.name}</option>`
  ).join('');
  selModel.value = state.modelId;

  selPreset.innerHTML = FACT_PRESETS.map(
    (p) => `<option value="${p.id}">${p.icon} ${p.name}</option>`
  ).join('');
  selPreset.value = state.presetId;

  updateDescriptions();
}

function updateDescriptions() {
  const model = INHOUSE_MODELS.find((m) => m.id === state.modelId);
  const preset = FACT_PRESETS.find((p) => p.id === state.presetId);
  if (modelDescEl && model) modelDescEl.textContent = model.description;
  if (presetDescEl && preset) presetDescEl.textContent = preset.description;
}

/**
 * Load an image URL or DataURL and run pixel analysis + resolution check
 */
async function loadSourceImage(src, displayName = 'image') {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      state.imgElement = img;
      state.imageSrc = src;
      state.imageName = displayName;
      imageFileNameEl.textContent = displayName;

      updateResolutionCheck();
      rebuildScenePlanFromModel();
      resolve(img);
    };
    img.onerror = (err) => {
      reject(err);
    };
    img.src = src;
  });
}

/**
 * Validate image resolution against minimum 1080p output frame
 */
function updateResolutionCheck() {
  if (!state.imgElement) return;
  const check = checkImageResolution(
    state.imgElement,
    state.aspectRatio,
    state.resolution,
    state.imageSrc
  );

  resWarningBanner.style.display = 'block';
  if (check.meetsMinResolution) {
    resWarningBanner.className = 'res-banner ok';
    resWarningBanner.textContent = `✓ ${check.message}`;
  } else {
    resWarningBanner.className = 'res-banner warn';
    resWarningBanner.textContent = `⚠️ ${check.message}`;
  }
}

/**
 * Update preview container display aspect ratio while keeping internal canvas at true 1080p/1440p
 */
function updateStageDisplayGeometry() {
  const { width, height } = getResolutionDims(state.aspectRatio, state.resolution);
  stageCanvas.width = width;
  stageCanvas.height = height;

  if (state.aspectRatio === '9:16') {
    stageViewport.style.width = '330px';
    stageViewport.style.height = '586px';
  } else {
    stageViewport.style.width = '640px';
    stageViewport.style.height = '360px';
  }

  const totalFrames = Math.round(state.duration * FIXED_FPS);
  frameScrubber.max = String(totalFrames - 1);
  if (state.currentFrame >= totalFrames) {
    state.currentFrame = 0;
  }

  specBadge.textContent = `${width}×${height} (${state.resolution}) • ${FIXED_FPS} FPS CFR • ${totalFrames} Frames`;
}

/**
 * Recompute Scene Plan using the active In-House Model & Preset
 */
function rebuildScenePlanFromModel() {
  state.scenePlan = buildScenePlan({
    img: state.imgElement,
    modelId: state.modelId,
    presetId: state.presetId,
    aspectRatio: state.aspectRatio,
    resolution: state.resolution,
    duration: state.duration,
    factTitle: state.factTitle,
    factSubtitle: state.factSubtitle
  });

  syncEditorContent();
  renderCurrentFrame();
}

/**
 * Sync right-hand Code Editor with active tab ('json' or 'js')
 */
function syncEditorContent() {
  if (state.editorTab === 'json') {
    codeEditor.value = JSON.stringify(state.scenePlan, null, 2);
    editorStatus.textContent = 'Scene Plan JSON (Editable — auto-applies on edit)';
    editorStatus.style.color = '#94a3b8';
  } else {
    codeEditor.value = state.customCodeSource;
    editorStatus.textContent = 'Custom Canvas 2D Layer (JavaScript function body)';
    editorStatus.style.color = '#94a3b8';
  }
}

/**
 * Parse edits from the live editor and apply them to the renderer
 */
function applyEditorChanges() {
  if (state.editorTab === 'json') {
    try {
      const parsed = JSON.parse(codeEditor.value);
      state.scenePlan = { ...state.scenePlan, ...parsed };
      if (typeof parsed.factTitle === 'string') {
        state.factTitle = parsed.factTitle;
        factTitleInput.value = parsed.factTitle;
      }
      if (typeof parsed.factSubtitle === 'string') {
        state.factSubtitle = parsed.factSubtitle;
        factSubtitleInput.value = parsed.factSubtitle;
      }
      editorStatus.textContent = '✓ Valid Scene Plan JSON applied live';
      editorStatus.style.color = '#34d399';
      renderCurrentFrame();
    } catch (err) {
      editorStatus.textContent = `⚠️ JSON Syntax Error: ${err.message}`;
      editorStatus.style.color = '#f87171';
    }
  } else {
    state.customCodeSource = codeEditor.value;
    try {
      const trimmed = state.customCodeSource.replace(/\/\/.*$/gm, '').trim();
      if (!trimmed) {
        state.customDrawFn = null;
      } else {
        state.customDrawFn = new Function('ctx', 'params', state.customCodeSource);
      }
      editorStatus.textContent = '✓ Custom Canvas 2D layer compiled & active';
      editorStatus.style.color = '#34d399';
      renderCurrentFrame();
    } catch (err) {
      editorStatus.textContent = `⚠️ JS Compile Error: ${err.message}`;
      editorStatus.style.color = '#f87171';
    }
  }
}

/**
 * Render exact frame `state.currentFrame` at `t = currentFrame / 30`
 */
function renderCurrentFrame() {
  const totalFrames = Math.round(state.duration * FIXED_FPS);
  const clampedFrame = ((state.currentFrame % totalFrames) + totalFrames) % totalFrames;
  const t = clampedFrame / FIXED_FPS;

  renderFrameAtTime(stageCtx, {
    img: state.imgElement,
    t,
    duration: state.duration,
    aspectRatio: state.aspectRatio,
    resolution: state.resolution,
    presetId: state.presetId,
    factTitle: state.factTitle,
    factSubtitle: state.factSubtitle,
    scenePlan: state.scenePlan,
    customDrawFn: state.customDrawFn
  });

  frameScrubber.value = String(clampedFrame);
  const padFrame = String(clampedFrame + 1).padStart(3, '0');
  const padTotal = String(totalFrames).padStart(3, '0');
  timelineReadout.textContent = `Frame ${padFrame} / ${padTotal} • ${t.toFixed(2)}s / ${state.duration.toFixed(1)}s • ${FIXED_FPS} FPS`;
}

/**
 * 30 FPS Constant Frame Rate playback loop
 */
function animationLoop(now) {
  const frameIntervalMs = 1000 / FIXED_FPS;
  if (state.isPlaying) {
    if (!state.lastTickTime) state.lastTickTime = now;
    const elapsed = now - state.lastTickTime;
    if (elapsed >= frameIntervalMs) {
      const steps = Math.max(1, Math.floor(elapsed / frameIntervalMs));
      const totalFrames = Math.round(state.duration * FIXED_FPS);
      state.currentFrame = (state.currentFrame + steps) % totalFrames;
      state.lastTickTime = now - (elapsed % frameIntervalMs);
      renderCurrentFrame();
    }
  }
  requestAnimationFrame(animationLoop);
}

/**
 * Save current scene plan / custom code to media/generated-code/
 */
async function saveSceneToDisk() {
  try {
    const baseName = state.imageName.replace(/\.[^.]+$/, '');
    const res = await fetch('/api/save-scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${baseName}-${state.presetId}-${state.aspectRatio.replace(':', 'x')}`,
        format: 'json',
        content: JSON.stringify(
          {
            ...state.scenePlan,
            customCodeSource: state.customCodeSource
          },
          null,
          2
        )
      })
    });
    const data = await res.json();
    if (data.ok) {
      editorStatus.textContent = `✓ Saved to ${data.path}`;
      editorStatus.style.color = '#34d399';
    }
  } catch (err) {
    editorStatus.textContent = `⚠️ Save failed: ${err.message}`;
    editorStatus.style.color = '#f87171';
  }
}

/**
 * Bind UI Event Listeners
 */
function bindEvents() {
  // File upload via click or drag-and-drop
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleUploadedFile(file);
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleUploadedFile(file);
  });

  sampleSelectEl.addEventListener('change', () => {
    const val = sampleSelectEl.value;
    const label = sampleSelectEl.options[sampleSelectEl.selectedIndex].text;
    loadSourceImage(val, label);
  });

  btnShorts.addEventListener('click', () => {
    state.aspectRatio = '9:16';
    btnShorts.classList.add('active');
    btnLandscape.classList.remove('active');
    updateStageDisplayGeometry();
    updateResolutionCheck();
    rebuildScenePlanFromModel();
  });

  btnLandscape.addEventListener('click', () => {
    state.aspectRatio = '16:9';
    btnLandscape.classList.add('active');
    btnShorts.classList.remove('active');
    updateStageDisplayGeometry();
    updateResolutionCheck();
    rebuildScenePlanFromModel();
  });

  selResolution.addEventListener('change', () => {
    state.resolution = selResolution.value;
    updateStageDisplayGeometry();
    updateResolutionCheck();
    rebuildScenePlanFromModel();
  });

  selDuration.addEventListener('change', () => {
    state.duration = Number(selDuration.value);
    state.currentFrame = 0;
    updateStageDisplayGeometry();
    rebuildScenePlanFromModel();
  });

  selModel.addEventListener('change', () => {
    state.modelId = selModel.value;
    updateDescriptions();
    rebuildScenePlanFromModel();
  });

  selPreset.addEventListener('change', () => {
    state.presetId = selPreset.value;
    updateDescriptions();
    rebuildScenePlanFromModel();
  });

  factTitleInput.addEventListener('input', () => {
    state.factTitle = factTitleInput.value;
    state.scenePlan.factTitle = state.factTitle;
    if (state.editorTab === 'json') syncEditorContent();
    renderCurrentFrame();
  });

  factSubtitleInput.addEventListener('input', () => {
    state.factSubtitle = factSubtitleInput.value;
    state.scenePlan.factSubtitle = state.factSubtitle;
    if (state.editorTab === 'json') syncEditorContent();
    renderCurrentFrame();
  });

  btnPlayPause.addEventListener('click', () => {
    state.isPlaying = !state.isPlaying;
    state.lastTickTime = 0;
    btnPlayPause.textContent = state.isPlaying ? '⏸ Pause' : '▶ Play 30 FPS';
  });

  frameScrubber.addEventListener('input', () => {
    state.isPlaying = false;
    btnPlayPause.textContent = '▶ Play 30 FPS';
    state.currentFrame = Number(frameScrubber.value);
    renderCurrentFrame();
  });

  tabJsonBtn.addEventListener('click', () => {
    state.editorTab = 'json';
    tabJsonBtn.classList.add('active');
    tabJsBtn.classList.remove('active');
    syncEditorContent();
  });

  tabJsBtn.addEventListener('click', () => {
    state.editorTab = 'js';
    tabJsBtn.classList.add('active');
    tabJsonBtn.classList.remove('active');
    syncEditorContent();
  });

  codeEditor.addEventListener('input', () => {
    applyEditorChanges();
  });

  btnApplyCode.addEventListener('click', () => {
    applyEditorChanges();
  });

  btnSaveScene.addEventListener('click', () => {
    saveSceneToDisk();
  });

  btnRegeneratePlan.addEventListener('click', () => {
    rebuildScenePlanFromModel();
  });
}

function handleUploadedFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    loadSourceImage(ev.target.result, file.name);
  };
  reader.readAsDataURL(file);
}

// Initialize Studio
initDropdowns();
updateStageDisplayGeometry();
bindEvents();
loadSourceImage(state.imageSrc, state.imageName).then(() => {
  requestAnimationFrame(animationLoop);
});
