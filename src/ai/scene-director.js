// AI Prompt-to-Code generator (Uses free Gemini / HuggingFace or intelligent local rule engine)

import { SceneConfig, getResolutionDims } from '../presets/fact-presets.js';

export function generateCustomAnimationCode(config: SceneConfig): { html: string; css: string; js: string } {
  const { width, height } = getResolutionDims(config.aspectRatio, config.resolution);
  const prompt = (config.customPrompt || '').toLowerCase();
  const duration = config.duration || 4;

  let zoomScale = 1.15;
  let rotateDeg = 0.8;
  let translateX = -20;
  let translateY = -30;
  let brightness = 1.1;

  if (prompt.includes('zoom out') || prompt.includes('pull back')) {
    zoomScale = 0.95;
    translateX = 15;
    translateY = 20;
  } else if (prompt.includes('dramatic') || prompt.includes('fast')) {
    zoomScale = 1.25;
    rotateDeg = 1.5;
  }

  const css = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html {
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: #000;
    }
    #stage {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
    }
    .scene-image {
      position: absolute;
      top: -8%;
      left: -8%;
      width: 116%;
      height: 116%;
      object-fit: cover;
      animation: cameraFlight ${duration}s cubic-bezier(0.2, 0.9, 0.4, 1) infinite alternate;
      will-change: transform, filter;
    }
    @keyframes cameraFlight {
      0% {
        transform: scale(1.0) translate3d(0, 0, 0) rotate(0deg);
        filter: brightness(0.96) contrast(1.05);
      }
      100% {
        transform: scale(${zoomScale}) translate3d(${translateX}px, ${translateY}px, 0) rotate(${rotateDeg}deg);
        filter: brightness(${brightness}) contrast(1.15);
      }
    }
    #vfxCanvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      mix-blend-mode: screen;
    }
    .cinema-vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, transparent 40%, rgba(0,0,0,0.6) 85%, rgba(0,0,0,0.95) 100%);
      pointer-events: none;
    }
  `;

  let js = `
    const canvas = document.getElementById('vfxCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = ${width};
    canvas.height = ${height};
  `;

  if (prompt.includes('rain') || prompt.includes('water')) {
    js += `
      const drops = Array.from({length: 120}, () => ({
        x: Math.random() * ${width},
        y: Math.random() * ${height},
        len: Math.random() * 30 + 15,
        speed: Math.random() * 18 + 12
      }));
      function loop() {
        ctx.clearRect(0, 0, ${width}, ${height});
        ctx.strokeStyle = 'rgba(180, 220, 255, 0.45)';
        ctx.lineWidth = 1.5;
        drops.forEach(d => {
          ctx.beginPath();
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x + 2, d.y + d.len);
          ctx.stroke();
          d.y += d.speed;
          if (d.y > ${height}) d.y = -d.len;
        });
        requestAnimationFrame(loop);
      }
      loop();
    `;
  } else if (prompt.includes('fire') || prompt.includes('ember') || prompt.includes('spark')) {
    js += `
      const embers = Array.from({length: 80}, () => ({
        x: Math.random() * ${width},
        y: Math.random() * ${height},
        size: Math.random() * 4 + 1,
        vy: - (Math.random() * 3 + 1.5),
        vx: (Math.random() - 0.5) * 1.5,
        alpha: Math.random() * 0.9 + 0.1
      }));
      function loop() {
        ctx.clearRect(0, 0, ${width}, ${height});
        embers.forEach(e => {
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2);
          ctx.fillStyle = \`rgba(255, 120, 30, \${e.alpha})\`;
          ctx.shadowBlur = 12;
          ctx.shadowColor = '#ff4500';
          ctx.fill();
          e.y += e.vy;
          e.x += e.vx;
          if (e.y < 0) e.y = ${height};
        });
        requestAnimationFrame(loop);
      }
      loop();
    `;
  } else {
    // Cinematic Golden Dust Particles default
    js += `
      const motes = Array.from({length: 70}, () => ({
        x: Math.random() * ${width},
        y: Math.random() * ${height},
        size: Math.random() * 3 + 0.8,
        vy: - (Math.random() * 0.8 + 0.2),
        vx: (Math.random() - 0.5) * 0.6,
        alpha: Math.random() * 0.6 + 0.3
      }));
      function loop() {
        ctx.clearRect(0, 0, ${width}, ${height});
        motes.forEach(m => {
          ctx.beginPath();
          ctx.arc(m.x, m.y, m.size, 0, Math.PI * 2);
          ctx.fillStyle = \`rgba(255, 235, 170, \${m.alpha})\`;
          ctx.shadowBlur = 8;
          ctx.shadowColor = 'rgba(255, 210, 80, 0.9)';
          ctx.fill();
          m.y += m.vy;
          m.x += m.vx;
          if (m.y < 0) m.y = ${height};
          if (m.x < 0) m.x = ${width};
          if (m.x > ${width}) m.x = 0;
        });
        requestAnimationFrame(loop);
      }
      loop();
    `;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <style>${css}</style>
</head>
<body>
  <div id="stage">
    <img class="scene-image" src="${config.imageSrc}" />
    <canvas id="vfxCanvas"></canvas>
    <div class="cinema-vignette"></div>
  </div>
  <script>${js}</script>
</body>
</html>`;

  return { html, css, js };
}
