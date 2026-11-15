// Studio UI Controller (Part 2: Frame-Accurate 1080p/30FPS H.264 MP4 Export + Batch Mode)

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
import {
  exportClipToMp4,
  saveVideoToOutputs
} from '../engine/exporter.js';

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
  editorTab: 'json', // 'json' | 'js' | 'batch'
  isPlaying: true,
  isExporting: false,
  currentFrame: 0,
  lastTickTime: 0,
  batchQueue: [],
  outputsList: []
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

const btnExportMp4 = document.getElementById('btnExportMp4');
const exportProgressWrap = document.getElementById('exportProgressWrap');
const exportProgressBar = document.getElementById('exportProgressBar');
const exportProgressText = document.getElementById('exportProgressText');
const exportVerifyBadge = document.getElementById('exportVerifyBadge');

const tabJsonBtn = document.getElementById('tabJsonBtn');
const tabJsBtn = document.getElementById('tabJsBtn');
const tabBatchBtn = document.getElementById('tabBatchBtn');

const codeEditorSection = document.getElementById('codeEditorSection');
const batchSection = document.getElementById('batchSection');

const codeEditor = document.getElementById('codeEditor');
const editorStatus = document.getElementById('editorStatus');
const btnApplyCode = document.getElementById('btnApplyCode');
const btnSaveScene = document.getElementById('btnSaveScene');
const btnRegeneratePlan = document.getElementById('btnRegeneratePlan');

// Batch & Outputs DOM
const batchFileInput = document.getElementById('batchFileInput');
const btnAddBatchFiles = document.getElementById('btnAddBatchFiles');
const btnAddSampleBatch = document.getElementById('btnAddSampleBatch');
const btnRunBatch = document.getElementById('btnRunBatch');
const batchQueueListEl = document.getElementById('batchQueueList');
const outputsListEl = document.getElementById('outputsList');

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

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}

async function loadSourceImage(src, displayName = 'image') {
  const img = await loadImageElement(src);
  state.imgElement = img;
  state.imageSrc = src;
  state.imageName = displayName;
  imageFileNameEl.textContent = displayName;

  updateResolutionCheck();
  rebuildScenePlanFromModel();
  return img;
}

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

function updateStageDisplayGeometry() {
  const { width, height } = getResolutionDims(state.aspectRatio, state.resolution);
  stageCanvas.width = width;
  stageCanvas.height = height;

  if (state.aspectRatio === '9:16') {
    stageViewport.style.width = '324px';
    stageViewport.style.height = '576px';
  } else {
    stageViewport.style.width = '608px';
    stageViewport.style.height = '342px';
  }

  const totalFrames = Math.round(state.duration * FIXED_FPS);
  frameScrubber.max = String(totalFrames - 1);
  if (state.currentFrame >= totalFrames) {
    state.currentFrame = 0;
  }

  specBadge.textContent = `${width}×${height} (${state.resolution}) • ${FIXED_FPS} FPS CFR • ${totalFrames} Frames`;
  btnExportMp4.textContent = `🎬 Export ${state.resolution} ${FIXED_FPS}FPS .MP4 (${state.duration}s)`;
}

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

function syncEditorContent() {
  if (state.editorTab === 'json') {
    codeEditor.value = JSON.stringify(state.scenePlan, null, 2);
    editorStatus.textContent = 'Scene Plan JSON (Editable — auto-applies on edit)';
    editorStatus.style.color = '#94a3b8';
  } else if (state.editorTab === 'js') {
    codeEditor.value = state.customCodeSource;
    editorStatus.textContent = 'Custom Canvas 2D Layer (JavaScript function body)';
    editorStatus.style.color = '#94a3b8';
  }
}

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
  } else if (state.editorTab === 'js') {
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

function animationLoop(now) {
  const frameIntervalMs = 1000 / FIXED_FPS;
  if (state.isPlaying && !state.isExporting) {
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
 * Export Single Clip to True 1080p+ / 30.000 FPS H.264 MP4 & Save to media/outputs/
 */
async function handleExportSingleClip() {
  if (state.isExporting || !state.imgElement) return;
  state.isExporting = true;
  btnExportMp4.disabled = true;
  exportProgressWrap.style.display = 'flex';
  exportVerifyBadge.style.display = 'none';

  try {
    const result = await exportClipToMp4({
      img: state.imgElement,
      duration: state.duration,
      aspectRatio: state.aspectRatio,
      resolution: state.resolution,
      presetId: state.presetId,
      factTitle: state.factTitle,
      factSubtitle: state.factSubtitle,
      scenePlan: state.scenePlan,
      customDrawFn: state.customDrawFn,
      mirrorCtx: stageCtx,
      onProgress: ({ frame, totalFrames, percent, phase }) => {
        exportProgressBar.style.width = `${percent}%`;
        exportProgressText.textContent =
          phase === 'muxing'
            ? `Muxing FastStart H.264 MP4 (${totalFrames} frames @ ${FIXED_FPS} FPS)...`
            : `Rendering & Encoding Frame ${String(frame).padStart(3, '0')} / ${totalFrames} (${percent}%) • ${FIXED_FPS} FPS CFR`;
      }
    });

    const cleanStem = state.imageName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '-');
    const outName = `${cleanStem}-${state.presetId}-${state.aspectRatio.replace(':', 'x')}-${state.resolution}-30fps.${result.ext}`;

    // 1. Save directly to media/outputs/ on disk
    const saved = await saveVideoToOutputs(result.bytes, outName);

    // 2. Trigger browser download
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = saved.fileName || outName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    // 3. Show verified MP4 spec badge
    const v = result.verification;
    const kb = (v.byteLength / 1024).toFixed(1);
    exportVerifyBadge.style.display = 'block';
    exportVerifyBadge.className = 'res-banner ok';
    exportVerifyBadge.innerHTML =
      `✓ <strong>Verified ${v.codec} .${result.ext.toUpperCase()}</strong> • ` +
      `${v.width}×${v.height} • <strong>${v.fps}.000 FPS CFR</strong> • ` +
      `${v.frameCount} Frames (${v.durationSec}s) • ${kb} KB • ` +
      `Saved to <a href="${saved.url}" target="_blank" style="color:#6ee7b7;text-decoration:underline;">media/outputs/${saved.fileName}</a>`;

    await refreshOutputsList();
  } catch (err) {
    exportVerifyBadge.style.display = 'block';
    exportVerifyBadge.className = 'res-banner warn';
    exportVerifyBadge.textContent = `⚠️ Export failed: ${err.message}`;
  } finally {
    state.isExporting = false;
    btnExportMp4.disabled = false;
    setTimeout(() => {
      exportProgressWrap.style.display = 'none';
    }, 1200);
  }
}

/**
 * Batch Mode Management (12–20 Clips for a Full Short)
 */
function addItemToBatchQueue({ name, src, presetId, duration, factTitle, factSubtitle }) {
  const idx = state.batchQueue.length;
  const autoPreset =
    presetId || FACT_PRESETS[idx % FACT_PRESETS.length].id;
  state.batchQueue.push({
    id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    src,
    presetId: autoPreset,
    duration: duration || state.duration,
    factTitle: factTitle ?? `FACT #${idx + 1}`,
    factSubtitle: factSubtitle ?? '',
    status: 'queued',
    outputUrl: null
  });
  renderBatchQueueUI();
}

function renderBatchQueueUI() {
  if (state.batchQueue.length === 0) {
    batchQueueListEl.innerHTML = `<div class="hint" style="padding:14px;text-align:center;">No clips in batch queue yet. Add multiple images or click "Load 2 Sample Clips" above.</div>`;
    return;
  }

  batchQueueListEl.innerHTML = state.batchQueue
    .map((item, i) => {
      const presetOptions = FACT_PRESETS.map(
        (p) =>
          `<option value="${p.id}" ${p.id === item.presetId ? 'selected' : ''}>${p.icon} ${p.name}</option>`
      ).join('');
      const badgeColor =
        item.status === 'done'
          ? '#34d399'
          : item.status === 'rendering'
          ? '#fcd34d'
          : '#94a3b8';

      return `
      <div class="batch-item" data-id="${item.id}">
        <div class="batch-item-top">
          <strong>#${i + 1} • ${item.name}</strong>
          <span style="font-size:0.74rem;color:${badgeColor};font-weight:700;">
            ${item.status.toUpperCase()}
            ${item.outputUrl ? ` — <a href="${item.outputUrl}" target="_blank" style="color:#34d399;">Download MP4</a>` : ''}
          </span>
        </div>
        <div class="batch-item-controls">
          <select class="batch-preset-sel" data-index="${i}">${presetOptions}</select>
          <select class="batch-dur-sel" data-index="${i}">
            <option value="3" ${item.duration === 3 ? 'selected' : ''}>3s (90f)</option>
            <option value="4" ${item.duration === 4 ? 'selected' : ''}>4s (120f)</option>
            <option value="5" ${item.duration === 5 ? 'selected' : ''}>5s (150f)</option>
          </select>
          <button class="btn btn-secondary batch-remove-btn" data-index="${i}" style="padding:5px 9px;font-size:0.74rem;">✕</button>
        </div>
        <input type="text" class="batch-title-inp" data-index="${i}" value="${item.factTitle.replace(/"/g, '&quot;')}" placeholder="Clip Headline (optional)" />
      </div>`;
    })
    .join('');

  batchQueueListEl.querySelectorAll('.batch-preset-sel').forEach((el) => {
    el.addEventListener('change', () => {
      const idx = Number(el.dataset.index);
      state.batchQueue[idx].presetId = el.value;
    });
  });

  batchQueueListEl.querySelectorAll('.batch-dur-sel').forEach((el) => {
    el.addEventListener('change', () => {
      const idx = Number(el.dataset.index);
      state.batchQueue[idx].duration = Number(el.value);
    });
  });

  batchQueueListEl.querySelectorAll('.batch-title-inp').forEach((el) => {
    el.addEventListener('input', () => {
      const idx = Number(el.dataset.index);
      state.batchQueue[idx].factTitle = el.value;
    });
  });

  batchQueueListEl.querySelectorAll('.batch-remove-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.index);
      state.batchQueue.splice(idx, 1);
      renderBatchQueueUI();
    });
  });
}

async function runBatchExport() {
  if (state.isExporting || state.batchQueue.length === 0) return;
  state.isExporting = true;
  btnRunBatch.disabled = true;
  btnExportMp4.disabled = true;
  exportProgressWrap.style.display = 'flex';

  try {
    for (let i = 0; i < state.batchQueue.length; i++) {
      const item = state.batchQueue[i];
      item.status = 'rendering';
      renderBatchQueueUI();

      const img = await loadImageElement(item.src);
      const plan = buildScenePlan({
        img,
        modelId: state.modelId,
        presetId: item.presetId,
        aspectRatio: state.aspectRatio,
        resolution: state.resolution,
        duration: item.duration,
        factTitle: item.factTitle,
        factSubtitle: item.factSubtitle
      });

      const res = await exportClipToMp4({
        img,
        duration: item.duration,
        aspectRatio: state.aspectRatio,
        resolution: state.resolution,
        presetId: item.presetId,
        factTitle: item.factTitle,
        factSubtitle: item.factSubtitle,
        scenePlan: plan,
        customDrawFn: state.customDrawFn,
        mirrorCtx: stageCtx,
        onProgress: ({ frame, totalFrames, percent }) => {
          exportProgressBar.style.width = `${percent}%`;
          exportProgressText.textContent = `Batch Clip ${i + 1}/${state.batchQueue.length}: Frame ${frame}/${totalFrames} (${percent}%)`;
        }
      });

      const stem = item.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
      const fileName = `batch-${String(i + 1).padStart(2, '0')}-${stem}-${item.presetId}-${state.resolution}-30fps.${res.ext}`;
      const saved = await saveVideoToOutputs(res.bytes, fileName);

      item.status = 'done';
      item.outputUrl = saved.url;
      renderBatchQueueUI();
    }

    await refreshOutputsList();
  } finally {
    state.isExporting = false;
    btnRunBatch.disabled = false;
    btnExportMp4.disabled = false;
    setTimeout(() => {
      exportProgressWrap.style.display = 'none';
    }, 1200);
  }
}

async function refreshOutputsList() {
  try {
    const res = await fetch('/api/media');
    const data = await res.json();
    state.outputsList = data.outputs || [];

    if (state.outputsList.length === 0) {
      outputsListEl.innerHTML = `<div class="hint">No rendered MP4 clips in media/outputs/ yet.</div>`;
      return;
    }

    outputsListEl.innerHTML = state.outputsList
      .slice(0, 8)
      .map((f) => {
        const kb = (f.sizeBytes / 1024).toFixed(1);
        return `
        <div class="output-row">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;" title="${f.name}">🎬 ${f.name}</span>
          <span>${kb} KB • <a href="${f.url}" download="${f.name}" style="color:#818cf8;">Download</a></span>
        </div>`;
      })
      .join('');
  } catch (_) {
    // Ignore fetch error
  }
}

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

function switchRightTab(tab) {
  state.editorTab = tab;
  tabJsonBtn.classList.toggle('active', tab === 'json');
  tabJsBtn.classList.toggle('active', tab === 'js');
  tabBatchBtn.classList.toggle('active', tab === 'batch');

  if (tab === 'batch') {
    codeEditorSection.style.display = 'none';
    batchSection.style.display = 'flex';
    renderBatchQueueUI();
  } else {
    codeEditorSection.style.display = 'flex';
    batchSection.style.display = 'none';
    syncEditorContent();
  }
}

function bindEvents() {
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 1) {
      handleUploadedFile(files[0]);
    } else if (files.length > 1) {
      handleMultipleBatchFiles(files);
      switchRightTab('batch');
    }
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

  btnExportMp4.addEventListener('click', () => {
    handleExportSingleClip();
  });

  tabJsonBtn.addEventListener('click', () => switchRightTab('json'));
  tabJsBtn.addEventListener('click', () => switchRightTab('js'));
  tabBatchBtn.addEventListener('click', () => switchRightTab('batch'));

  codeEditor.addEventListener('input', () => applyEditorChanges());
  btnApplyCode.addEventListener('click', () => applyEditorChanges());
  btnSaveScene.addEventListener('click', () => saveSceneToDisk());
  btnRegeneratePlan.addEventListener('click', () => rebuildScenePlanFromModel());

  // Batch Mode Controls
  btnAddBatchFiles.addEventListener('click', () => batchFileInput.click());
  batchFileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) handleMultipleBatchFiles(files);
  });

  btnAddSampleBatch.addEventListener('click', () => {
    addItemToBatchQueue({
      name: 'sample-ancient-pyramid.svg',
      src: '/media/samples/sample-ancient-pyramid.svg',
      presetId: 'documentary-kenburns',
      duration: 3,
      factTitle: 'FACT #1: PYRAMID ALIGNMENT',
      factSubtitle: 'Aligned to true north within 3/60th of a degree.'
    });
    addItemToBatchQueue({
      name: 'sample-space-nebula.svg',
      src: '/media/samples/sample-space-nebula.svg',
      presetId: '3d-perspective-tilt',
      duration: 3,
      factTitle: 'FACT #2: STELLAR NURSERIES',
      factSubtitle: 'Nebulae span light-years where new stars ignite.'
    });
  });

  btnRunBatch.addEventListener('click', () => {
    runBatchExport();
  });
}

function handleUploadedFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    loadSourceImage(ev.target.result, file.name);
  };
  reader.readAsDataURL(file);
}

function handleMultipleBatchFiles(files) {
  files.forEach((file) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      addItemToBatchQueue({
        name: file.name,
        src: ev.target.result,
        duration: state.duration
      });
    };
    reader.readAsDataURL(file);
  });
}

// Initialize Studio
initDropdowns();
updateStageDisplayGeometry();
bindEvents();
refreshOutputsList();
loadSourceImage(state.imageSrc, state.imageName).then(() => {
  requestAnimationFrame(animationLoop);
});
