const http = require('http');
const fs = require('fs');
const path = require('path');

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

function readRequestBody(req, maxBytes = 25 * 1024 * 1024) {
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

function listMediaFiles(relDir, exts) {
  const absDir = path.join(ROOT, relDir);
  if (!fs.existsSync(absDir)) return [];
  return fs
    .readdirSync(absDir)
    .filter((f) => !f.startsWith('.') && exts.includes(path.extname(f).toLowerCase()))
    .map((f) => ({
      name: f,
      url: `/${relDir.replace(/\\/g, '/')}/${encodeURIComponent(f)}`
    }));
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    // API: list available sample & input images and saved scenes
    if (req.method === 'GET' && pathname === '/api/media') {
      const imageExts = ['.svg', '.png', '.jpg', '.jpeg', '.webp'];
      const samples = listMediaFiles('media/samples', imageExts);
      const inputs = listMediaFiles('media/inputs', imageExts);
      const scenes = listMediaFiles('media/generated-code', ['.json', '.js', '.html']);
      return sendJson(res, 200, { samples, inputs, scenes });
    }

    // API: save generated scene code/plan to media/generated-code/
    if (req.method === 'POST' && pathname === '/api/save-scene') {
      const bodyBuffer = await readRequestBody(req);
      const data = JSON.parse(bodyBuffer.toString('utf8'));
      const safeName = String(data.name || `scene-${Date.now()}`)
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 60);
      const ext = data.format === 'html' ? '.html' : '.json';
      const fileName = `${safeName}${ext}`;
      const targetPath = path.join(ROOT, 'media', 'generated-code', fileName);

      fs.writeFileSync(targetPath, String(data.content || ''), 'utf8');
      return sendJson(res, 200, {
        ok: true,
        fileName,
        path: `/media/generated-code/${fileName}`
      });
    }

    // Static file serving with strict path traversal protection
    const relativeTarget = pathname === '/' ? '/src/index.html' : pathname;
    const resolvedPath = path.resolve(ROOT, '.' + relativeTarget);

    // Block any path outside ROOT or hidden .git/.env files
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
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(resolvedPath).pipe(res);
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`🎬 AI Image-to-Video Studio (1080p / 30 FPS) running at: http://localhost:${PORT}`);
});
