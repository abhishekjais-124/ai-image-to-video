// Shared test helpers (no dependencies).

/** A real avcC record captured from this engine's encoder (Baseline L4.0, 1080×1920, limited-range BT.709). */
export const REAL_AVCC = Uint8Array.from(
  Buffer.from('01420028ffe1001027420028ab402201e3cbcd404340408001000428ce3c80', 'hex')
);

/** Build one AVCC sample: a single NAL of `nalLength` bytes with the given header byte. */
export function makeAvccSample(nalLength, headerByte = 0x21, fill = 0x55) {
  const out = new Uint8Array(4 + nalLength);
  out[0] = (nalLength >>> 24) & 0xff;
  out[1] = (nalLength >>> 16) & 0xff;
  out[2] = (nalLength >>> 8) & 0xff;
  out[3] = nalLength & 0xff;
  out[4] = headerByte;
  for (let i = 5; i < out.length; i++) out[i] = (fill + i) & 0x7f || 1;
  return out;
}

/** N synthetic samples: a keyframe every `gop` frames. */
export function makeSamples(count, { gop = 30, size = (i) => 600 + (i % 7) * 40 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    data: makeAvccSample(size(i), i % gop === 0 ? 0x65 : 0x21),
    isKeyframe: i % gop === 0
  }));
}

/**
 * Recording stand-in for a CanvasRenderingContext2D. Every method is a no-op;
 * property writes and gradient colour stops are recorded so tests can assert
 * on blend modes and alpha values without a real canvas.
 */
export function createMockContext(width = 1080, height = 1920) {
  const log = { compositeOps: [], colorStops: [], fillStyles: [], texts: [], calls: [] };
  const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', font: '' };
  const gradient = () => ({ addColorStop: (stop, color) => log.colorStops.push({ stop, color }) });
  const target = {
    canvas: { width, height },
    createRadialGradient: gradient,
    createLinearGradient: gradient,
    measureText: (text) => ({ width: String(text).length * 20 }),
    fillText: (text, x, y) => log.texts.push({ text, x, y, alpha: state.globalAlpha, fill: state.fillStyle }),
    strokeText: () => {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
  };
  return {
    log,
    ctx: new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        if (prop in state) return state[prop];
        return (...args) => {
          log.calls.push(prop);
          return undefined;
        };
      },
      set(obj, prop, value) {
        state[prop] = value;
        if (prop === 'globalCompositeOperation') log.compositeOps.push(value);
        if (prop === 'fillStyle' && typeof value === 'string') log.fillStyles.push(value);
        return true;
      },
      has(obj, prop) {
        return prop in obj || prop in state || prop === 'letterSpacing' || prop === 'filter';
      }
    })
  };
}

/** Largest alpha found in a list of rgba() colour strings. */
export function maxAlpha(colors) {
  let max = 0;
  for (const c of colors) {
    const m = String(c).match(/rgba\([^)]*,\s*([0-9.]+)\s*\)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** RGBA test image: `painter(x, y)` returns [r, g, b]. */
export function makeImage(w, h, painter) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = painter(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}
