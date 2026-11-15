// Built-in presets for Fact Shorts cinematic animation
// Each preset generates complete standalone HTML/CSS/Canvas/WebGL animation code

export interface SceneConfig {
  aspectRatio: '9:16' | '16:9';
  resolution: '720p' | '1080p';
  duration: number; // 3, 4, or 5 seconds
  preset: string;
  imageSrc: string;
  customPrompt?: string;
  factTitle?: string;
  factSubtitle?: string;
}

export const FACT_PRESETS = [
  {
    id: 'documentary-kenburns',
    name: 'Documentary Ken Burns + Dust',
    description: 'Smooth cinematic slow zoom with floating ambient dust particles and warm vignette. Ideal for historical, nature, and deep facts.',
    icon: '📽️'
  },
  {
    id: '3d-perspective-tilt',
    name: '3D Perspective Tilt + Spotlight',
    description: 'Dynamic 3D camera pan/tilt with an animated moving spotlight highlighting the subject. High retention for viral shorts.',
    icon: '✨'
  },
  {
    id: 'mystery-fog-shake',
    name: 'Mystery Fog + Handheld Pulse',
    description: 'Atmospheric rolling mist, volumetric shadow pulses, and subtle handheld documentary camera motion.',
    icon: '🌫️'
  },
  {
    id: 'scifi-cyber-glitch',
    name: 'Sci-Fi Cyber Grid + Glitch',
    description: 'Digital holographic scan lines, chromatic aberration pulse, and high-tech glow for tech and futuristic facts.',
    icon: '⚡'
  },
  {
    id: 'vintage-film-grain',
    name: 'Vintage Film Grain + Light Leaks',
    description: 'Authentic 16mm/35mm film grain jitter with organic warm light leaks and subtle shutter flicker.',
    icon: '🎞️'
  }
];

export function getResolutionDims(aspectRatio: '9:16' | '16:9', resolution: '720p' | '1080p') {
  if (aspectRatio === '9:16') {
    return resolution === '1080p' ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  } else {
    return resolution === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  }
}

export function generateSceneHtml(config: SceneConfig): string {
  const { width, height } = getResolutionDims(config.aspectRatio, config.resolution);
  const duration = config.duration || 4;
  const image = config.imageSrc;
  const title = config.factTitle || '';
  const subtitle = config.factSubtitle || '';

  // Preset specific shaders / canvas scripts
  let effectScript = '';

  if (config.preset === 'documentary-kenburns') {
    effectScript = `
      // Floating dust particles
      const canvas = document.getElementById('effectCanvas');
      const ctx = canvas.getContext('2d');
      const particles = Array.from({length: 60}, () => ({
        x: Math.random() * ${width},
        y: Math.random() * ${height},
        radius: Math.random() * 2.5 + 0.5,
        alpha: Math.random() * 0.7 + 0.2,
        vx: (Math.random() - 0.5) * 0.4,
        vy: - (Math.random() * 0.8 + 0.3)
      }));

      function renderFrame() {
        ctx.clearRect(0, 0, ${width}, ${height});
        particles.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fillStyle = \`rgba(255, 235, 180, \${p.alpha})\`;
          ctx.shadowBlur = 10;
          ctx.shadowColor = 'rgba(255, 215, 100, 0.8)';
          ctx.fill();
          p.x += p.vx;
          p.y += p.vy;
          if (p.y < 0) p.y = ${height};
          if (p.x < 0) p.x = ${width};
          if (p.x > ${width}) p.x = 0;
        });
        requestAnimationFrame(renderFrame);
      }
      renderFrame();
    `;
  } else if (config.preset === '3d-perspective-tilt') {
    effectScript = `
      // Dynamic moving spotlight + specular flare
      const canvas = document.getElementById('effectCanvas');
      const ctx = canvas.getContext('2d');
      let startTime = performance.now();

      function renderFrame(now) {
        const elapsed = (now - startTime) / 1000;
        const progress = (elapsed % ${duration}) / ${duration};
        ctx.clearRect(0, 0, ${width}, ${height});

        const spotX = ${width} * 0.3 + Math.sin(progress * Math.PI * 2) * (${width} * 0.35);
        const spotY = ${height} * 0.4 + Math.cos(progress * Math.PI * 2) * (${height} * 0.2);

        const grad = ctx.createRadialGradient(spotX, spotY, 20, spotX, spotY, ${width} * 0.75);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
        grad.addColorStop(0.4, 'rgba(255, 220, 180, 0.12)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, ${width}, ${height});
        requestAnimationFrame(renderFrame);
      }
      requestAnimationFrame(renderFrame);
    `;
  } else if (config.preset === 'scifi-cyber-glitch') {
    effectScript = `
      // Cyber scanline grid + chromatic pulse
      const canvas = document.getElementById('effectCanvas');
      const ctx = canvas.getContext('2d');
      let t = 0;

      function renderFrame() {
        ctx.clearRect(0, 0, ${width}, ${height});
        t += 1.5;

        // Scan line
        const scanY = (t * 6) % ${height};
        ctx.fillStyle = 'rgba(0, 240, 255, 0.25)';
        ctx.fillRect(0, scanY, ${width}, 4);
        ctx.shadowBlur = 15;
        ctx.shadowColor = '#00f0ff';

        // Grid overlay
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.04)';
        ctx.lineWidth = 1;
        for (let x = 0; x < ${width}; x += 80) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ${height}); ctx.stroke();
        }
        for (let y = 0; y < ${height}; y += 80) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(${width}, y); ctx.stroke();
        }
        requestAnimationFrame(renderFrame);
      }
      renderFrame();
    `;
  } else {
    // Default / Mist / Film
    effectScript = `
      const canvas = document.getElementById('effectCanvas');
      const ctx = canvas.getContext('2d');
      let frame = 0;
      function renderFrame() {
        ctx.clearRect(0, 0, ${width}, ${height});
        frame++;
        // Film grain noise
        const imgData = ctx.createImageData(${width}, ${height});
        const buffer = new Uint32Array(imgData.data.buffer);
        for (let i = 0; i < buffer.length; i += 4) {
          if (Math.random() < 0.08) {
            buffer[i] = (Math.random() * 255) << 24 | 0x00ffffff;
          }
        }
        ctx.putImageData(imgData, 0, 0);
        requestAnimationFrame(renderFrame);
      }
      renderFrame();
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${width}, height=${height}, initial-scale=1.0" />
  <title>Fact Short Scene (${config.aspectRatio} ${config.resolution})</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html {
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: #000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #stage {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      perspective: 1200px;
    }
    .main-image {
      position: absolute;
      top: -5%;
      left: -5%;
      width: 110%;
      height: 110%;
      object-fit: cover;
      transform-origin: center center;
      animation: cameraMotion ${duration}s cubic-bezier(0.25, 1, 0.5, 1) infinite alternate;
      will-change: transform, filter;
    }
    @keyframes cameraMotion {
      0% {
        transform: scale(1.0) translate3d(0, 0, 0) rotate(0deg);
        filter: brightness(0.95) contrast(1.05);
      }
      100% {
        transform: scale(1.14) translate3d(-15px, -25px, 0) rotate(0.6deg);
        filter: brightness(1.08) contrast(1.12);
      }
    }
    #effectCanvas {
      position: absolute;
      top: 0;
      left: 0;
      width: ${width}px;
      height: ${height}px;
      pointer-events: none;
      mix-blend-mode: screen;
    }
    .vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, transparent 45%, rgba(0,0,0,0.65) 90%, rgba(0,0,0,0.92) 100%);
      pointer-events: none;
    }
    .fact-card {
      position: absolute;
      bottom: ${config.aspectRatio === '9:16' ? '240px' : '60px'};
      left: 50%;
      transform: translateX(-50%);
      width: 85%;
      text-align: center;
      color: #fff;
      text-shadow: 0 4px 18px rgba(0,0,0,0.85);
      z-index: 10;
      pointer-events: none;
    }
    .fact-title {
      font-size: ${config.aspectRatio === '9:16' ? '56px' : '44px'};
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 2px;
      background: linear-gradient(180deg, #ffffff 30%, #ffd166 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 12px;
    }
    .fact-subtitle {
      font-size: ${config.aspectRatio === '9:16' ? '32px' : '26px'};
      font-weight: 600;
      color: #e2e8f0;
      line-height: 1.35;
    }
  </style>
</head>
<body>
  <div id="stage">
    <img class="main-image" src="${image}" alt="Fact Scene" />
    <canvas id="effectCanvas" width="${width}" height="${height}"></canvas>
    <div class="vignette"></div>
    ${title ? `
    <div class="fact-card">
      <div class="fact-title">${title}</div>
      ${subtitle ? `<div class="fact-subtitle">${subtitle}</div>` : ''}
    </div>` : ''}
  </div>

  <script>
    ${effectScript}
  </script>
</body>
</html>`;
}
