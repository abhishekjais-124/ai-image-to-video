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
import { CHARACTER_ACTIONS } from '../engine/character.js';
import { RENDER_QUALITIES, beatForProgress } from '../engine/exporter.js';

// Built-in lossless 1080x1920 SVG Data URLs so samples always load even in sandboxed/embedded previews
const BUILTIN_SAMPLES = {
  pyramid:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <defs>
    <linearGradient id="sky" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#090714"/>
      <stop offset="55%" stop-color="#2c1638"/>
      <stop offset="80%" stop-color="#b55933"/>
      <stop offset="100%" stop-color="#f2a649"/>
    </linearGradient>
    <radialGradient id="moon" cx="50%" cy="32%" r="16%">
      <stop offset="0%" stop-color="#fff4d2"/>
      <stop offset="60%" stop-color="#f7b955" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#f7b955" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#sky)"/>
  <circle cx="540" cy="614" r="280" fill="url(#moon)"/>
  <polygon points="540,720 120,1520 960,1520" fill="#1c0e18"/>
  <polygon points="540,720 540,1520 960,1520" fill="#11080f"/>
  <rect y="1500" width="1080" height="420" fill="#0d060a"/>
</svg>`),
  nebula:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <defs>
    <radialGradient id="nebula" cx="50%" cy="42%" r="60%">
      <stop offset="0%" stop-color="#ff6b9d" stop-opacity="0.9"/>
      <stop offset="35%" stop-color="#6b2cf5" stop-opacity="0.7"/>
      <stop offset="70%" stop-color="#0b133a" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#030511" stop-opacity="1"/>
    </radialGradient>
    <radialGradient id="core" cx="50%" cy="42%" r="18%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#ffe599"/>
      <stop offset="100%" stop-color="#ff6b9d" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#nebula)"/>
  <circle cx="540" cy="806" r="240" fill="url(#core)"/>
  <g fill="#ffffff" opacity="0.8">
    <circle cx="180" cy="300" r="3"/><circle cx="880" cy="240" r="4"/><circle cx="720" cy="420" r="2.5"/>
    <circle cx="320" cy="600" r="3.5"/><circle cx="920" cy="780" r="3"/><circle cx="140" cy="1100" r="4"/>
    <circle cx="640" cy="1350" r="3"/><circle cx="390" cy="1520" r="5"/><circle cx="840" cy="1600" r="3.5"/>
  </g>
</svg>`)
};

const state = {
  aspectRatio: '9:16',
  resolution: '1080p',
  duration: 3,
  renderQuality: 'cinematic',
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
  characterEnabled: true,
  characterAction: 'walk-point',
  characterImgElement: null,
  characterImgName: '',
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
  document.body.classList.toggle('tools-open', !!open);
  if (btnTogglePanel) {
    btnTogglePanel.setAttribute('aria-pressed', String(!!open));
  }
  try {
    localStorage.setItem('studio.toolsOpen', open ? '1' : '0');
  } catch (_) {
    // Storage unavailable
  }
}

const btnShorts = document.getElementById('btnShorts');
const btnLandscape = document.getElementById('btnLandscape');
const selResolution = document.getElementById('selResolution');
const selDuration = document.getElementById('selDuration');
const selQuality = document.getElementById('selQuality');
const qualityHintEl = document.getElementById('qualityHint');
const renderStatusWrap = document.getElementById('renderStatusWrap');
const renderStatusText = document.getElementById('renderStatusText');
const renderBeatText = document.getElementById('renderBeatText');
const selModel = document.getElementById('selModel');
const modelDescEl = document.getElementById('modelDesc');
const selPreset = document.getElementById('selPreset');
const presetDescEl = document.getElementById('presetDesc');
const selCharacterAction = document.getElementById('selCharacterAction');
const chkCharacter = document.getElementById('chkCharacter');
const btnCharacterUpload = document.getElementById('btnCharacterUpload');
const characterFileInput = document.getElementById('characterFileInput');
const characterFileNameEl = document.getElementById('characterFileName');
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

function setPlayButtonState() {
  btnPlayPause.dataset.playing = String(state.isPlaying);
  const label = state.isPlaying ? 'Pause' : 'Play';
  btnPlayPause.setAttribute('aria-label', label);
  const labelEl = document.getElementById('playBtnLabel');
  if (labelEl) labelEl.textContent = label;
}

function initDropdowns() {
  selModel.innerHTML = INHOUSE_MODELS.map(
    (m) => `<option value="${m.id}">${m.name}</option>`
  ).join('');
  selModel.value = state.modelId;

  selPreset.innerHTML = FACT_PRESETS.map(
    (p) => `<option value="${p.id}">${p.name}</option>`
  ).join('');
  selPreset.value = state.presetId;

  selQuality.innerHTML = RENDER_QUALITIES.map(
    (q) => `<option value="${q.id}" title="${q.description}">${q.name}</option>`
  ).join('');
  selQuality.value = state.renderQuality;

  selCharacterAction.innerHTML = CHARACTER_ACTIONS.map(
    (a) => `<option value="${a.id}" title="${a.description}">${a.name}</option>`
  ).join('');
  selCharacterAction.value = state.characterAction;

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

function resolveFallbackSampleDataUrl(src = '') {
  if (String(src).includes('nebula')) return BUILTIN_SAMPLES.nebula;
  return BUILTIN_SAMPLES.pyramid;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!String(src).startsWith('data:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => {
      // Fallback to embedded lossless SVG sample if relative/server path is unreachable
      const fallback = resolveFallbackSampleDataUrl(src);
      if (src !== fallback) {
        const fbImg = new Image();
        fbImg.onload = () => resolve(fbImg);
        fbImg.onerror = (err) => reject(err);
        fbImg.src = fallback;
      } else {
        reject(new Error('Failed to load image'));
      }
    };
    img.src = src;
  });
}

async function loadSourceImage(src, displayName = 'image') {
  const img = await loadImageElement(src);
  state.imgElement = img;
  state.imageSrc = img.src || src;
  state.imageName = displayName;
  imageFileNameEl.textContent = displayName;
  imageThumbEl.src = img.src || src;

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
    autoSelectPreset,
    characterAction: state.characterAction,
    characterEnabled: state.characterEnabled
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
    customDrawFn: state.customDrawFn,
    characterImg: state.characterImgElement
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

/**
 * Trigger browser file download reliably across Chrome, Safari, and embedded webviews
 */
function triggerBrowserDownload(blob, fileName) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = blobUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 500);
  return blobUrl;
}

function formatEta(ms) {
  if (!ms || ms <= 0) return 'almost done';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s left` : `${s}s left`;
}
function formatElapsed(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// Live render update: called for every frame the exporter finishes, so
// the stage canvas (mirrored frame) + this text move together in real time.
function updateLiveRenderStatus({ frame, totalFrames, percent, phase, beat, elapsedMs, etaMs, quality }) {
  renderStatusWrap.style.display = 'flex';
  exportProgressWrap.style.display = 'flex';
  const phaseLabel = { analysing: 'Analysing image…', encoding: 'Rendering frames…', recording: 'Recording frames…', muxing: 'Muxing MP4…' }[phase] || phase;
  renderStatusText.textContent =
    `${phaseLabel} Frame ${frame}/${totalFrames} · ${percent}% · ${formatElapsed(elapsedMs)} elapsed · ${formatEta(etaMs)}`;
  const beatName = beat || beatForProgress(frame / Math.max(1, totalFrames));
  const total = totalFrames;
  renderBeatText.textContent =
    `Now: ${beatName}  —  Walk in (1–${Math.round(total * 0.34)}) · Point & talk (${Math.round(total * 0.34) + 1}–${Math.round(total * 0.74)}) · React (${Math.round(total * 0.74) + 1}–${total})  ·  ${quality === 'cinematic' ? 'Cinematic Natural' : 'Fast'}`;
  exportProgressBar.style.width = `${percent}%`;
}

async function handleExportSingleClip() {
  if (state.isExporting) return;

  state.isExporting = true;
  window.__exportStartedAt = Date.now();
  btnExportMp4.disabled = true;
  btnExportMp4.textContent = 'Starting…';
  renderStatusWrap.style.display = 'flex';
  exportProgressWrap.style.display = 'flex';
  renderStatusText.textContent = state.renderQuality === 'cinematic'
    ? 'Cinematic Natural render — 2–5 min for a 3s clip. Watch the stage: every frame appears live as it renders.'
    : 'Fast render starting…';
  exportProgressBar.style.width = '2%';
  exportProgressText.textContent = 'Preparing 1080p 30 FPS encoder…';
  exportVerifyBadge.style.display = 'none';

  try {
    // Ensure source image is loaded even if initial fetch had not finished
    if (!state.imgElement) {
      await loadSourceImage(state.imageSrc, state.imageName);
    }

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
      characterImg: state.characterImgElement,
      mirrorCtx: stageCtx,
      quality: state.renderQuality,
      onProgress: (info) => {
        updateLiveRenderStatus(info);
        btnExportMp4.textContent =
          info.phase === 'muxing' ? 'Muxing MP4…' : `Exporting ${info.percent}%…`;
        exportProgressText.textContent =
          info.phase === 'muxing'
            ? 'Finalizing FastStart H.264 MP4…'
            : `Rendering frame ${info.frame} of ${info.totalFrames} (${info.percent}%) · ${info.beat || ''}`;
      }
    });

    const cleanStem = state.imageName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '-');
    const outName = `${cleanStem}-${state.modelId}-s${state.variationSeed}-${state.aspectRatio.replace(':', 'x')}-${state.resolution}-30fps.${result.ext}`;

    // 1. Trigger browser download immediately (never blocked by server status)
    const blobUrl = triggerBrowserDownload(result.blob, outName);

    // 2. Also persist to media/outputs/ on disk if local server is running
    const saved = await saveVideoToOutputs(result.bytes, outName);
    const downloadHref = saved?.url || blobUrl;
    const finalFileName = saved?.fileName || outName;

    const v = result.verification;
    const sizeMb = v.byteLength / (1024 * 1024);
    const kb = sizeMb >= 1 ? `${sizeMb.toFixed(1)} MB` : `${(v.byteLength / 1024).toFixed(0)} KB`;

    renderStatusText.textContent = `✓ Rendered in ${formatElapsed(Date.now() - (window.__exportStartedAt || Date.now()))} — watch it back above, then download below.`;
    btnExportMp4.textContent = '✓ Exported MP4';
    exportVerifyBadge.style.display = 'block';
    exportVerifyBadge.className = 'res-banner ok';
    exportVerifyBadge.innerHTML =
      `✓ Ready: <a href="${downloadHref}" download="${escapeHtml(finalFileName)}" target="_blank"><strong>Download ${escapeHtml(finalFileName)}</strong></a> ` +
      `<span class="meta">· ${v.width} × ${v.height} · ${v.fps} fps · ${v.durationSec}s · ${kb}</span>`;
    exportVerifyBadge.title = `${v.codec} · ${v.frameCount} frames`;

    await refreshMediaLists();
  } catch (err) {
    btnExportMp4.textContent = 'Export Failed';
    exportVerifyBadge.style.display = 'block';
    exportVerifyBadge.className = 'res-banner warn';
    exportVerifyBadge.textContent = `Export failed: ${err.message || err}`;
  } finally {
    state.isExporting = false;
    btnExportMp4.disabled = false;
    setTimeout(() => {
      btnExportMp4.textContent = 'Export MP4';
      exportProgressWrap.style.display = 'none';
    }, 2200);
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
            ${statusLabel[item.status] || item.status}${item.outputUrl ? ` · <a href="${item.outputUrl}" download target="_blank">Download</a>` : ''}
          </span>
        </div>
        <div class="batch-item-controls">
          <select class="batch-preset-sel" data-index="${i}" aria-label="Look">${presetOptions}</select>
          <select class="batch-dur-sel" data-index="${i}" aria-label="Duration">
            <option value="3" ${item.duration === 3 ? 'selected' : ''}>3s</option>
            <option value="4" ${item.duration === 4 ? 'selected' : ''}>4s</option>
            <option value="5" ${item.duration === 5 ? 'selected' : ''}>5s</option>
          </select>
          <button type="button" class="batch-remove-btn" data-index="${i}" aria-label="Remove from queue">✕</button>
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
        variationSeed: i + 1,
        characterAction: state.characterAction,
        characterEnabled: state.characterEnabled
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
        characterImg: state.characterImgElement,
        mirrorCtx: stageCtx,
        quality: state.renderQuality,
        onProgress: (info) => {
          updateLiveRenderStatus(info);
          btnRunBatch.textContent = `Clip ${i + 1}/${state.batchQueue.length} (${info.percent}%)…`;
          exportProgressText.textContent = `Clip ${i + 1} of ${state.batchQueue.length} · ${info.percent}% · ${info.beat || ''}`;
        }
      });

      const stem = item.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
      const fileName = `batch-${String(i + 1).padStart(2, '0')}-${stem}-${item.presetId}-${state.resolution}-30fps.${res.ext}`;
      const blobUrl = triggerBrowserDownload(res.blob, fileName);
      const saved = await saveVideoToOutputs(res.bytes, fileName);

      item.status = 'done';
      item.outputUrl = saved?.url || blobUrl;
      renderBatchQueueUI();
    }

    await refreshMediaLists();
  } finally {
    state.isExporting = false;
    btnRunBatch.disabled = false;
    btnRunBatch.textContent = 'Render batch';
    btnExportMp4.disabled = false;
    setTimeout(() => {
      exportProgressWrap.style.display = 'none';
    }, 1200);
  }
}

async function refreshMediaLists() {
  try {
    const res = await fetch('/api/media');
    if (!res.ok) return;
    const data = await res.json();
    state.outputsList = data.outputs || [];
    state.scenesList = data.scenes || [];

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
    // Ignore fetch error in standalone preview
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
    if (typeof data.characterAction === 'string' && CHARACTER_ACTIONS.some((a) => a.id === data.characterAction)) {
      state.characterAction = data.characterAction;
      selCharacterAction.value = data.characterAction;
    }
    if (typeof data.characterEnabled === 'boolean') {
      state.characterEnabled = data.characterEnabled;
      chkCharacter.checked = data.characterEnabled;
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
      await loadImageElement(data.imageSrc)
        .then((img) => {
          state.imgElement = img;
          state.imageSrc = img.src || data.imageSrc;
          state.imageName = data.imageSrc.split('/').pop();
          imageFileNameEl.textContent = state.imageName;
          imageThumbEl.src = state.imageSrc;
          updateResolutionCheck();
        })
        .catch(() => {});
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

function on(el, event, handler) {
  if (el && typeof el.addEventListener === 'function') {
    el.addEventListener(event, handler);
  }
}

function bindEvents() {
  on(dropzone, 'click', () => fileInput && fileInput.click());
  on(dropzone, 'dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  on(dropzone, 'dragleave', () => dropzone.classList.remove('dragover'));
  on(dropzone, 'drop', (e) => {
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
  on(fileInput, 'change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleUploadedFile(file);
  });

  on(sampleSelectEl, 'change', () => {
    const val = sampleSelectEl.value;
    if (!val) return;
    loadSourceImage(val, val.split('/').pop());
  });

  on(btnShorts, 'click', () => {
    state.aspectRatio = '9:16';
    btnShorts.classList.add('active');
    btnLandscape.classList.remove('active');
    updateStageDisplayGeometry();
    updateResolutionCheck();
    rebuildScenePlanFromModel();
  });

  on(btnLandscape, 'click', () => {
    state.aspectRatio = '16:9';
    btnLandscape.classList.add('active');
    btnShorts.classList.remove('active');
    updateStageDisplayGeometry();
    updateResolutionCheck();
    rebuildScenePlanFromModel();
  });

  on(selResolution, 'change', () => {
    state.resolution = selResolution.value;
    updateStageDisplayGeometry();
    updateResolutionCheck();
    rebuildScenePlanFromModel();
  });

  on(selQuality, 'change', () => {
    state.renderQuality = selQuality.value;
    const q = RENDER_QUALITIES.find((x) => x.id === state.renderQuality);
    if (q && qualityHintEl) qualityHintEl.textContent = q.description + (state.renderQuality === 'cinematic' ? ' The stage shows every frame live as it renders.' : '');
  });

  on(selDuration, 'change', () => {
    state.duration = Number(selDuration.value);
    state.currentFrame = 0;
    updateStageDisplayGeometry();
    rebuildScenePlanFromModel();
  });

  on(selModel, 'change', () => {
    state.modelId = selModel.value;
    state.variationSeed = 1;
    updateDescriptions();
    rebuildScenePlanFromModel({ autoSelectPreset: true });
  });

  on(selPreset, 'change', () => {
    state.presetId = selPreset.value;
    updateDescriptions();
    rebuildScenePlanFromModel({ autoSelectPreset: false });
  });

  on(motionPromptInput, 'input', () => {
    state.motionPrompt = motionPromptInput.value;
    rebuildScenePlanFromModel({ autoSelectPreset: false });
  });

  on(factTitleInput, 'input', () => {
    state.factTitle = factTitleInput.value;
    state.scenePlan.factTitle = state.factTitle;
    if (state.editorTab === 'json') syncEditorContent();
    renderCurrentFrame();
  });

  on(factSubtitleInput, 'input', () => {
    state.factSubtitle = factSubtitleInput.value;
    state.scenePlan.factSubtitle = state.factSubtitle;
    if (state.editorTab === 'json') syncEditorContent();
    renderCurrentFrame();
  });

  on(selCharacterAction, 'change', () => {
    state.characterAction = selCharacterAction.value;
    rebuildScenePlanFromModel({ autoSelectPreset: false });
  });

  on(chkCharacter, 'change', () => {
    state.characterEnabled = chkCharacter.checked;
    rebuildScenePlanFromModel({ autoSelectPreset: false });
  });

  on(btnCharacterUpload, 'click', () => characterFileInput && characterFileInput.click());
  on(characterFileInput, 'change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      loadImageElement(ev.target.result)
        .then((img) => {
          state.characterImgElement = img;
          state.characterImgName = file.name;
          if (characterFileNameEl) characterFileNameEl.textContent = `Cutout: ${file.name} — it walks instead of the drawn presenter`;
          renderCurrentFrame();
        })
        .catch(() => {
          if (characterFileNameEl) characterFileNameEl.textContent = `Could not load ${file.name}`;
        });
    };
    reader.readAsDataURL(file);
  });

  on(btnVariation, 'click', () => {
    state.variationSeed += 1;
    rebuildScenePlanFromModel({ autoSelectPreset: false });
  });

  on(btnRegeneratePlan, 'click', () => {
    state.variationSeed = 1;
    rebuildScenePlanFromModel({ autoSelectPreset: true });
  });

  on(selSavedScene, 'change', () => {
    if (selSavedScene.value) {
      loadSavedSceneFromUrl(selSavedScene.value);
    }
  });

  on(btnPlayPause, 'click', () => {
    state.isPlaying = !state.isPlaying;
    state.lastTickTime = 0;
    setPlayButtonState();
  });

  on(frameScrubber, 'input', () => {
    state.isPlaying = false;
    setPlayButtonState();
    state.currentFrame = Number(frameScrubber.value);
    renderCurrentFrame();
  });

  on(btnExportMp4, 'click', () => {
    handleExportSingleClip();
  });

  on(btnTogglePanel, 'click', () => {
    setToolsOpen(!document.body.classList.contains('tools-open'));
  });

  const btnCloseTools = document.getElementById('btnCloseTools');
  const toolsBackdrop = document.getElementById('toolsBackdrop');
  on(btnCloseTools, 'click', () => setToolsOpen(false));
  on(toolsBackdrop, 'click', () => setToolsOpen(false));

  on(tabJsonBtn, 'click', () => switchRightTab('json'));
  on(tabJsBtn, 'click', () => switchRightTab('js'));
  on(tabBatchBtn, 'click', () => switchRightTab('batch'));

  on(codeEditor, 'input', () => applyEditorChanges());
  on(btnApplyCode, 'click', () => applyEditorChanges());
  on(btnSaveScene, 'click', () => saveSceneToDisk());

  // Batch Mode Controls
  on(btnAddBatchFiles, 'click', () => batchFileInput && batchFileInput.click());
  on(batchFileInput, 'change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) handleMultipleBatchFiles(files);
  });

  on(btnAddSampleBatch, 'click', () => {
    addItemToBatchQueue({
      name: 'sample-ancient-pyramid.svg',
      src: BUILTIN_SAMPLES.pyramid,
      presetId: 'documentary-kenburns',
      duration: 3,
      factTitle: 'FACT #1: PYRAMID ALIGNMENT',
      factSubtitle: 'Aligned to true north within 3/60th of a degree.'
    });
    addItemToBatchQueue({
      name: 'sample-space-nebula.svg',
      src: BUILTIN_SAMPLES.nebula,
      presetId: '3d-perspective-tilt',
      duration: 3,
      factTitle: 'FACT #2: STELLAR NURSERIES',
      factSubtitle: 'Nebulae span light-years where new stars ignite.'
    });
  });

  on(btnRunBatch, 'click', () => {
    runBatchExport();
  });
}

function handleUploadedFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    if (sampleSelectEl) sampleSelectEl.value = '';
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

function initStudio() {
  try {
    // Only auto-open tools on wide desktop screens (> 1180px)
    let toolsOpenSaved = false;
    try {
      toolsOpenSaved = window.innerWidth > 1180 && localStorage.getItem('studio.toolsOpen') === '1';
    } catch (_) {}
    setToolsOpen(toolsOpenSaved);
  } catch (e) {
    console.warn('[Studio] setToolsOpen error:', e);
  }

  try { setPlayButtonState(); } catch (e) { console.warn(e); }
  try { initDropdowns(); } catch (e) { console.warn(e); }
  try { updateStageDisplayGeometry(); } catch (e) { console.warn(e); }
  try { bindEvents(); } catch (e) { console.warn(e); }
  try { refreshMediaLists(); } catch (e) { console.warn(e); }
  try { requestAnimationFrame(animationLoop); } catch (e) { console.warn(e); }
  loadSourceImage(state.imageSrc, state.imageName).catch((err) => {
    console.warn('[Studio] Fallback image load:', err);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStudio);
} else {
  initStudio();
}
