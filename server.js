import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function readRequestBody(req, maxBytes = 150 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sanitizeFileName(raw, fallbackExt = '.mp4') {
  const base = path.basename(String(raw || `clip-${Date.now()}${fallbackExt}`));
  const ext = path.extname(base).toLowerCase() || fallbackExt;
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return `${stem || 'clip'}${ext}`;
}

function listMediaFiles(relDir, exts) {
  const absDir = path.join(ROOT, relDir);
  if (!fs.existsSync(absDir)) return [];
  return fs
    .readdirSync(absDir)
    .filter((f) => !f.startsWith('.') && exts.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      const full = path.join(absDir, f);
      const stat = fs.statSync(full);
      return {
        name: f,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        url: `/${relDir.replace(/\\/g, '/')}/${encodeURIComponent(f)}`
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    // API: list samples, inputs, scenes, and rendered MP4 outputs
    if (req.method === 'GET' && pathname === '/api/media') {
      const imageExts = ['.svg', '.png', '.jpg', '.jpeg', '.webp'];
      const samples = listMediaFiles('media/samples', imageExts);
      const inputs = listMediaFiles('media/inputs', imageExts);
      const scenes = listMediaFiles('media/generated-code', ['.json', '.js', '.html']);
      const outputs = listMediaFiles('media/outputs', ['.mp4', '.webm']);
      return sendJson(res, 200, { samples, inputs, scenes, outputs });
    }

    // API: save generated scene plan/code to media/generated-code/
    if (req.method === 'POST' && pathname === '/api/save-scene') {
      const bodyBuffer = await readRequestBody(req, 10 * 1024 * 1024);
      const data = JSON.parse(bodyBuffer.toString('utf8'));
      const ext = data.format === 'html' ? '.html' : '.json';
      const fileName = sanitizeFileName(`${data.name || `scene-${Date.now()}`}${ext}`, ext);
      const targetPath = path.join(ROOT, 'media', 'generated-code', fileName);

      fs.writeFileSync(targetPath, String(data.content || ''), 'utf8');
      return sendJson(res, 200, {
        ok: true,
        fileName,
        path: `/media/generated-code/${encodeURIComponent(fileName)}`
      });
    }

    // API: save rendered 1080p/30fps MP4 clip directly to media/outputs/
    if (req.method === 'POST' && pathname === '/api/save-video') {
      const rawName = parsedUrl.searchParams.get('name') || `fact-short-${Date.now()}.mp4`;
      const fileName = sanitizeFileName(rawName, '.mp4');
      const videoBuffer = await readRequestBody(req, 150 * 1024 * 1024);
      const outDir = path.join(ROOT, 'media', 'outputs');
      fs.mkdirSync(outDir, { recursive: true });
      const targetPath = path.join(outDir, fileName);

      fs.writeFileSync(targetPath, videoBuffer);
      return sendJson(res, 200, {
        ok: true,
        fileName,
        sizeBytes: videoBuffer.byteLength,
        url: `/media/outputs/${encodeURIComponent(fileName)}`
      });
    }

    // Static file serving with strict path traversal protection
    const relativeTarget = pathname === '/' ? '/src/index.html' : pathname;
    let resolvedPath = path.resolve(ROOT, '.' + relativeTarget);

    if (!fs.existsSync(resolvedPath)) {
      const srcCandidate = path.resolve(ROOT, 'src', '.' + relativeTarget);
      if (
        srcCandidate.startsWith(path.join(ROOT, 'src') + path.sep) &&
        fs.existsSync(srcCandidate)
      ) {
        resolvedPath = srcCandidate;
      }
    }

    if (
      !resolvedPath.startsWith(ROOT + path.sep) ||
      resolvedPath.includes(`${path.sep}.git${path.sep}`) ||
      path.basename(resolvedPath).startsWith('.env')
    ) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    fs.stat(resolvedPath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      fs.createReadStream(resolvedPath).pipe(res);
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`🎬 AI Image-to-Video Studio (1080p / 30 FPS MP4) running at: http://localhost:${PORT}`);
});
