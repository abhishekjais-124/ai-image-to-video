// Studio UI Controller (Part 3: Multi-Model Variation System, Prompt Director, Agent Scene Loader & MP4 Export)

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
  variationSeed: 1,
  presetId: 'documentary-kenburns',
  motionPrompt: '',
  imageSrc: '/media/samples/sample-ancient-pyramid.svg',
  imageName: 'sample-ancient-pyramid.svg',
  imgElement: null,
  factTitle: 'DID YOU KNOW?',
  factSubtitle:
    'The Great Pyramid of Giza aligns with true north within 3/60th of a single degree.',
  scenePlan: {},
  customCodeSource: '',
  customDrawFn: null,
  editorTab: 'json', // 'json' | 'js' | 'batch'
  isPlaying: true,
  isExporting: false,
  currentFrame: 0,
  lastTickTime: 0,
  batchQueue: [],
  outputsList: [],
  scenesList: []
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
const imageThumbEl = document.getElementById('imageThumb');
const btnTogglePanel = document.getElementById('btnTogglePanel');

const COLOR_MUTED = '#8b8b93';
const COLOR_OK = '#7fd4a8';
const COLOR_ERR = '#f08a8a';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function setToolsOpen(open) {
  document.body.classList.toggle('tools-open', open);
  btnTogglePanel.setAttribute('aria-pressed', String(open));
  try {
    localStorage.setItem('studio.toolsOpen', open ? '1' : '0');
  } catch (_) {
    // Storage unavailable — panel state just won't persist
  }
}

function setPlayButtonState() {
  btnPlayPause.dataset.playing = String(state.isPlaying);
  const label = state.isPlaying ? 'Pause' : 'Play';
  btnPlayPause.setAttribute('aria-label', label);
  const labelEl = document.getElementById('playBtnLabel');
  if (labelEl) labelEl.textContent = label;
}

const btnShorts = document.getElementById('btnShorts');
const btnLandscape = document.getElementById('btnLandscape');
const selResolution = document.getElementById('selResolution');
const selDuration = document.getElementById('selDuration');
const selModel = document.getElementById('selModel');
const modelDescEl = document.getElementById('modelDesc');
const selPreset = document.getElementById('selPreset');
const presetDescEl = document.getElementById('presetDesc');
const motionPromptInput = document.getElementById('motionPrompt');

const factTitleInput = document.getElementById('factTitle');
const factSubtitleInput = document.getElementById('factSubtitle');

const btnVariation = document.getElementById('btnVariation');
const btnRegeneratePlan = document.getElementById('btnRegeneratePlan');
const selSavedScene = document.getElementById('selSavedScene');

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
    (p) => `<option value="${p.id}">${p.name}</option>`
  ).join('');
  selPreset.value = state.presetId;

  updateDescriptions();
}

function updateDescriptions() {
  const model = INHOUSE_MODELS.find((m) => m.id === state.modelId);
  const preset = FACT_PRESETS.find((p) => p.id === state.presetId);
  if (model) selModel.title = model.description;
  if (preset) selPreset.title = preset.description;
  if (modelDescEl && model) modelDescEl.textContent = model.description;
  if (presetDescEl && preset) presetDescEl.textContent = preset.description;
}

function compileCustomCode(codeStr) {
  state.customCodeSource = String(codeStr || '');
  try {
    const trimmed = state.customCodeSource.replace(/\/\/.*$/gm, '').trim();
    if (!trimmed) {
      state.customDrawFn = null;
    } else {
      state.customDrawFn = new Function('ctx', 'params', state.customCodeSource);
    }
    return true;
  } catch (_) {
    state.customDrawFn = null;
    return false;
  }
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
  imageThumbEl.src = src;

  updateResolutionCheck();
  rebuildScenePlanFromModel({ autoSelectPreset: false });
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

  if (check.meetsMinResolution) {
    resWarningBanner.style.display = 'none';
  } else {
    resWarningBanner.style.display = 'block';
    resWarningBanner.className = 'res-banner warn';
    resWarningBanner.textContent = check.message;
  }
}

function updateStageDisplayGeometry() {
  const { width, height } = getResolutionDims(state.aspectRatio, state.resolution);
  stageCanvas.width = width;
  stageCanvas.height = height;

  stageViewport.dataset.aspect = state.aspectRatio;

  const totalFrames = Math.round(state.duration * FIXED_FPS);
  frameScrubber.max = String(totalFrames - 1);
  if (state.currentFrame >= totalFrames) {
    state.currentFrame = 0;
  }

  specBadge.textContent = `${width} × ${height} · ${FIXED_FPS} fps · ${state.duration}s`;
  specBadge.title = `${totalFrames} frames, constant frame rate, H.264 MP4`;
}

function rebuildScenePlanFromModel({ autoSelectPreset = false } = {}) {
  const plan = buildScenePlan({
    img: state.imgElement,
    modelId: state.modelId,
    presetId: state.presetId,
    aspectRatio: state.aspectRatio,
    resolution: state.resolution,
    duration: state.duration,
    factTitle: state.factTitle,
    factSubtitle: state.factSubtitle,
    motionPrompt: state.motionPrompt,
    variationSeed: state.variationSeed,
    autoSelectPreset
  });

  state.scenePlan = plan;
  if (plan.presetId && plan.presetId !== state.presetId) {
    state.presetId = plan.presetId;
    selPreset.value = state.presetId;
    updateDescriptions();
  }

  if (plan.generatedCustomCode) {
    compileCustomCode(plan.generatedCustomCode);
  }

  btnVariation.innerHTML = `New variation <span class="seed">#${state.variationSeed}</span>`;
  syncEditorContent();
  renderCurrentFrame();
}

function syncEditorContent() {
  if (state.editorTab === 'json') {
    const cleanPlan = { ...state.scenePlan };
    delete cleanPlan.generatedCustomCode;
    codeEditor.value = JSON.stringify(cleanPlan, null, 2);
    editorStatus.textContent = `${state.modelId} · seed ${state.variationSeed}`;
    editorStatus.style.color = COLOR_MUTED;
  } else if (state.editorTab === 'js') {
    codeEditor.value = state.customCodeSource;
    editorStatus.textContent = `Canvas 2D layer · ctx, params`;
    editorStatus.style.color = COLOR_MUTED;
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
      if (typeof parsed.presetId === 'string' && parsed.presetId !== state.presetId) {
        state.presetId = parsed.presetId;
        selPreset.value = parsed.presetId;
      }
      editorStatus.textContent = 'Applied';
      editorStatus.style.color = COLOR_OK;
      renderCurrentFrame();
    } catch (err) {
      editorStatus.textContent = `JSON error: ${err.message}`;
      editorStatus.style.color = COLOR_ERR;
    }
  } else if (state.editorTab === 'js') {
    const ok = compileCustomCode(codeEditor.value);
    if (ok) {
      editorStatus.textContent = 'Applied';
      editorStatus.style.color = COLOR_OK;
      renderCurrentFrame();
    } else {
      editorStatus.textContent = 'Syntax error in custom code';
      editorStatus.style.color = COLOR_ERR;
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
  timelineReadout.textContent = `${t.toFixed(2)} / ${state.duration.toFixed(2)}s`;
  timelineReadout.title = `Frame ${clampedFrame + 1} of ${totalFrames}`;
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
            ? 'Finalizing…'
            : `Rendering frame ${frame} of ${totalFrames}`;
      }
    });

    const cleanStem = state.imageName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '-');
    const outName = `${cleanStem}-${state.modelId}-s${state.variationSeed}-${state.aspectRatio.replace(':', 'x')}-${state.resolution}-30fps.${result.ext}`;

    const saved = await saveVideoToOutputs(result.bytes, outName);

    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = saved.fileName || outName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    const v = result.verification;
    const sizeMb = v.byteLength / (1024 * 1024);
    const kb = sizeMb >= 1 ? `${sizeMb.toFixed(1)} MB` : `${(v.byteLength / 1024).toFixed(0)} KB`;
    exportVerifyBadge.style.display = 'block';
    exportVerifyBadge.className = 'res-banner ok';
    exportVerifyBadge.innerHTML =
      `Saved <a href="${saved.url}" target="_blank">${escapeHtml(saved.fileName)}</a> ` +
      `<span class="meta">· ${v.width} × ${v.height} · ${v.fps} fps · ${v.durationSec}s · ${kb}</span>`;
    exportVerifyBadge.title = `${v.codec} · ${v.frameCount} frames · saved in media/outputs/`;

    await refreshMediaLists();
  } catch (err) {
    exportVerifyBadge.style.display = 'block';
    exportVerifyBadge.className = 'res-banner warn';
    exportVerifyBadge.textContent = `Export failed: ${err.message}`;
  } finally {
    state.isExporting = false;
    btnExportMp4.disabled = false;
    setTimeout(() => {
      exportProgressWrap.style.display = 'none';
    }, 1200);
  }
}

function addItemToBatchQueue({ name, src, presetId, duration, factTitle, factSubtitle }) {
  const idx = state.batchQueue.length;
  const autoPreset = presetId || FACT_PRESETS[idx % FACT_PRESETS.length].id;
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
    batchQueueListEl.innerHTML = `<div class="batch-empty">Queue is empty. Add images to render them one after another.</div>`;
    return;
  }

  const statusLabel = { queued: 'Queued', rendering: 'Rendering…', done: 'Done' };

  batchQueueListEl.innerHTML = state.batchQueue
    .map((item, i) => {
      const presetOptions = FACT_PRESETS.map(
        (p) =>
          `<option value="${p.id}" ${p.id === item.presetId ? 'selected' : ''}>${p.name}</option>`
      ).join('');

      return `
      <div class="batch-item" data-id="${item.id}">
        <div class="batch-item-top">
          <span class="batch-name" title="${escapeHtml(item.name)}"><span class="n">${String(i + 1).padStart(2, '0')}</span>${escapeHtml(item.name)}</span>
          <span class="batch-status" data-status="${item.status}">
            ${statusLabel[item.status] || item.status}${item.outputUrl ? ` · <a href="${item.outputUrl}" target="_blank">Open</a>` : ''}
          </span>
        </div>
        <div class="batch-item-controls">
          <select class="batch-preset-sel" data-index="${i}" aria-label="Look">${presetOptions}</select>
          <select class="batch-dur-sel" data-index="${i}" aria-label="Duration">
            <option value="3" ${item.duration === 3 ? 'selected' : ''}>3s</option>
            <option value="4" ${item.duration === 4 ? 'selected' : ''}>4s</option>
            <option value="5" ${item.duration === 5 ? 'selected' : ''}>5s</option>
          </select>
          <button class="batch-remove-btn" data-index="${i}" aria-label="Remove from queue">✕</button>
        </div>
        <input type="text" class="batch-title-inp" data-index="${i}" value="${escapeHtml(item.factTitle)}" placeholder="Headline (optional)" />
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
        factSubtitle: item.factSubtitle,
        motionPrompt: state.motionPrompt,
        variationSeed: i + 1
      });

      let batchCustomFn = null;
      if (plan.generatedCustomCode) {
        try {
          batchCustomFn = new Function('ctx', 'params', plan.generatedCustomCode);
        } catch (_) {
          batchCustomFn = null;
        }
      }

      const res = await exportClipToMp4({
        img,
        duration: item.duration,
        aspectRatio: state.aspectRatio,
        resolution: state.resolution,
        presetId: item.presetId,
        factTitle: item.factTitle,
        factSubtitle: item.factSubtitle,
        scenePlan: plan,
        customDrawFn: batchCustomFn,
        mirrorCtx: stageCtx,
        onProgress: ({ frame, totalFrames, percent }) => {
          exportProgressBar.style.width = `${percent}%`;
          exportProgressText.textContent = `Clip ${i + 1} of ${state.batchQueue.length} · ${percent}%`;
        }
      });

      const stem = item.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
      const fileName = `batch-${String(i + 1).padStart(2, '0')}-${stem}-${item.presetId}-${state.resolution}-30fps.${res.ext}`;
      const saved = await saveVideoToOutputs(res.bytes, fileName);

      item.status = 'done';
      item.outputUrl = saved.url;
      renderBatchQueueUI();
    }

    await refreshMediaLists();
  } finally {
    state.isExporting = false;
    btnRunBatch.disabled = false;
    btnExportMp4.disabled = false;
    setTimeout(() => {
      exportProgressWrap.style.display = 'none';
    }, 1200);
  }
}

async function refreshMediaLists() {
  try {
    const res = await fetch('/api/media');
    const data = await res.json();
    state.outputsList = data.outputs || [];
    state.scenesList = data.scenes || [];

    // Populate Saved / Agent-Generated Scenes dropdown
    selSavedScene.innerHTML =
      `<option value="">${state.scenesList.length ? `Load saved scene (${state.scenesList.length})…` : 'No saved scenes yet'}</option>` +
      state.scenesList
        .map((s) => `<option value="${s.url}">${escapeHtml(s.name)}</option>`)
        .join('');

    if (state.outputsList.length === 0) {
      outputsListEl.innerHTML = `<div class="hint">Nothing rendered yet.</div>`;
      return;
    }

    outputsListEl.innerHTML = state.outputsList
      .slice(0, 8)
      .map((f) => {
        const mb = f.sizeBytes / (1024 * 1024);
        const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${(f.sizeBytes / 1024).toFixed(0)} KB`;
        return `
        <div class="output-row">
          <span class="name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          <span class="meta">${size}<a href="${f.url}" download="${escapeHtml(f.name)}">Download</a></span>
        </div>`;
      })
      .join('');
  } catch (_) {
    // Ignore fetch error
  }
}

async function loadSavedSceneFromUrl(url) {
  if (!url) return;
  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.aspectRatio === '16:9' || data.aspectRatio === '9:16') {
      state.aspectRatio = data.aspectRatio;
      btnShorts.classList.toggle('active', state.aspectRatio === '9:16');
      btnLandscape.classList.toggle('active', state.aspectRatio === '16:9');
    }
    if (data.resolution === '1080p' || data.resolution === '1440p') {
      state.resolution = data.resolution;
      selResolution.value = data.resolution;
    }
    if ([3, 4, 5].includes(Number(data.duration))) {
      state.duration = Number(data.duration);
      selDuration.value = String(state.duration);
    }
    if (data.modelId && INHOUSE_MODELS.some((m) => m.id === data.modelId)) {
      state.modelId = data.modelId;
      selModel.value = data.modelId;
    }
    if (data.presetId && FACT_PRESETS.some((p) => p.id === data.presetId)) {
      state.presetId = data.presetId;
      selPreset.value = data.presetId;
    }
    if (typeof data.factTitle === 'string') {
      state.factTitle = data.factTitle;
      factTitleInput.value = data.factTitle;
    }
    if (typeof data.factSubtitle === 'string') {
      state.factSubtitle = data.factSubtitle;
      factSubtitleInput.value = data.factSubtitle;
    }

    state.scenePlan = data;
    const customCode = data.customCodeSource || data.generatedCustomCode || '';
    compileCustomCode(customCode);

    updateDescriptions();
    updateStageDisplayGeometry();
    syncEditorContent();

    if (data.imageSrc && data.imageSrc !== state.imageSrc) {
      await loadImageElement(data.imageSrc).then((img) => {
        state.imgElement = img;
        state.imageSrc = data.imageSrc;
        state.imageName = data.imageSrc.split('/').pop();
        imageFileNameEl.textContent = state.imageName;
        imageThumbEl.src = data.imageSrc;
        updateResolutionCheck();
      }).catch(() => {});
    }

    renderCurrentFrame();
    editorStatus.textContent = `Loaded ${decodeURIComponent(url).split('/').pop()}`;
    editorStatus.style.color = COLOR_OK;
  } catch (err) {
    editorStatus.textContent = `Couldn't load scene: ${err.message}`;
    editorStatus.style.color = COLOR_ERR;
  }
}

async function saveSceneToDisk() {
  try {
    const baseName = state.imageName.replace(/\.[^.]+$/, '');
    const res = await fetch('/api/save-scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${baseName}-${state.modelId}-s${state.variationSeed}-${state.aspectRatio.replace(':', 'x')}`,
        format: 'json',
        content: JSON.stringify(
          {
            ...state.scenePlan,
            imageSrc: state.imageSrc.startsWith('data:') ? undefined : state.imageSrc,
            customCodeSource: state.customCodeSource
          },
          null,
          2
        )
      })
    });
    const data = await res.json();
    if (data.ok) {
      editorStatus.textContent = `Saved ${data.fileName}`;
      editorStatus.style.color = COLOR_OK;
      await refreshMediaLists();
    }
  } catch (err) {
    editorStatus.textContent = `Save failed: ${err.message}`;
    editorStatus.style.color = COLOR_ERR;
  }
}

function switchRightTab(tab) {
  setToolsOpen(true);
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
    if (!val) return;
    loadSourceImage(val, val.split('/').pop());
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
    state.variationSeed = 1;
    updateDescriptions();
    rebuildScenePlanFromModel({ autoSelectPreset: true });
  });

  selPreset.addEventListener('change', () => {
    state.presetId = selPreset.value;
    updateDescriptions();
    rebuildScenePlanFromModel({ autoSelectPreset: false });
  });

  motionPromptInput.addEventListener('input', () => {
    state.motionPrompt = motionPromptInput.value;
    rebuildScenePlanFromModel({ autoSelectPreset: false });
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

  btnVariation.addEventListener('click', () => {
    state.variationSeed += 1;
    rebuildScenePlanFromModel({ autoSelectPreset: false });
  });

  btnRegeneratePlan.addEventListener('click', () => {
    state.variationSeed = 1;
    rebuildScenePlanFromModel({ autoSelectPreset: true });
  });

  selSavedScene.addEventListener('change', () => {
    if (selSavedScene.value) {
      loadSavedSceneFromUrl(selSavedScene.value);
    }
  });

  btnPlayPause.addEventListener('click', () => {
    state.isPlaying = !state.isPlaying;
    state.lastTickTime = 0;
    setPlayButtonState();
  });

  frameScrubber.addEventListener('input', () => {
    state.isPlaying = false;
    setPlayButtonState();
    state.currentFrame = Number(frameScrubber.value);
    renderCurrentFrame();
  });

  btnExportMp4.addEventListener('click', () => {
    handleExportSingleClip();
  });

  btnTogglePanel.addEventListener('click', () => {
    setToolsOpen(!document.body.classList.contains('tools-open'));
  });

  tabJsonBtn.addEventListener('click', () => switchRightTab('json'));
  tabJsBtn.addEventListener('click', () => switchRightTab('js'));
  tabBatchBtn.addEventListener('click', () => switchRightTab('batch'));

  codeEditor.addEventListener('input', () => applyEditorChanges());
  btnApplyCode.addEventListener('click', () => applyEditorChanges());
  btnSaveScene.addEventListener('click', () => saveSceneToDisk());

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
    sampleSelectEl.value = '';
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
let toolsOpenSaved = false;
try {
  toolsOpenSaved = localStorage.getItem('studio.toolsOpen') === '1';
} catch (_) {
  // Storage unavailable
}
setToolsOpen(toolsOpenSaved);
setPlayButtonState();
initDropdowns();
updateStageDisplayGeometry();
bindEvents();
refreshMediaLists();
loadSourceImage(state.imageSrc, state.imageName).then(() => {
  requestAnimationFrame(animationLoop);
});
