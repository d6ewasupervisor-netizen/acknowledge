const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_LOCAL_HANDBOOK_DIR = path.join(ROOT_DIR, 'employeeHandbook');
const HANDBOOK_DIR = process.env.EMPLOYEE_HANDBOOK_DIR
  || (fs.existsSync(DEFAULT_LOCAL_HANDBOOK_DIR) ? DEFAULT_LOCAL_HANDBOOK_DIR : 'C:\\Assets\\employeeHandbook');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function safeJoin(base, rel) {
  const joined = path.normalize(path.join(base, rel));
  const baseNorm = path.normalize(base + path.sep);
  if (!joined.startsWith(baseNorm)) return null;
  return joined;
}

async function fileExists(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function walkFiles(dir, relBase = '') {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = path.posix.join(relBase, ent.name);
    if (ent.isDirectory()) {
      out.push(...await walkFiles(abs, rel));
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

let manifestCache = { at: 0, value: null };
async function getHandbookManifest() {
  const now = Date.now();
  if (manifestCache.value && now - manifestCache.at < 10_000) return manifestCache.value;

  const advDir = path.join(HANDBOOK_DIR, 'ADV_Handbook');
  const suppDir = path.join(HANDBOOK_DIR, 'State_Supplement');
  const iconsDir = path.join(HANDBOOK_DIR, 'Icons');
  const logosDir = path.join(HANDBOOK_DIR, 'Logos');

  const advAll = await walkFiles(advDir);
  const suppAll = await walkFiles(suppDir);
  const iconsAll = await walkFiles(iconsDir);
  const logosAll = await walkFiles(logosDir);

  const adv = advAll.filter(p => p.toLowerCase().endsWith('.txt')).sort((a, b) => a.localeCompare(b));
  const supplement = suppAll.filter(p => p.toLowerCase().endsWith('.txt')).sort((a, b) => a.localeCompare(b));
  const isImage = (p) => {
    const ext = path.extname(p).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp'].includes(ext);
  };
  const icons = iconsAll.filter(isImage).sort((a, b) => a.localeCompare(b));
  const logos = logosAll.filter(isImage).sort((a, b) => a.localeCompare(b));

  const value = {
    base: HANDBOOK_DIR,
    adv: adv.map(p => `ADV_Handbook/${p}`),
    supplement: supplement.map(p => `State_Supplement/${p}`),
    icons: icons.map(p => `Icons/${p}`),
    logos: logos.map(p => `Logos/${p}`)
  };

  manifestCache = { at: now, value };
  return value;
}

async function serveStaticFile(res, absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = await fsp.readFile(absPath);
    send(res, 200, data, { 'Content-Type': mime });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname || '/');

    if (pathname === '/api/handbook-manifest') {
      const manifest = await getHandbookManifest();
      return send(res, 200, JSON.stringify(manifest), { 'Content-Type': MIME['.json'] });
    }

    if (pathname.startsWith('/employeeHandbook/')) {
      const rel = pathname.replace(/^\/employeeHandbook\//, '');
      const abs = safeJoin(HANDBOOK_DIR, rel);
      if (!abs) return send(res, 400, 'Bad path', { 'Content-Type': 'text/plain; charset=utf-8' });
      return serveStaticFile(res, abs);
    }

    // Default: serve app files from repo root
    let rel = pathname.replace(/^\//, '');
    if (!rel) rel = 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = safeJoin(ROOT_DIR, rel);
    if (!abs) return send(res, 400, 'Bad path', { 'Content-Type': 'text/plain; charset=utf-8' });

    // If path is a directory, serve its index.html
    try {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) {
        const idx = path.join(abs, 'index.html');
        if (await fileExists(idx)) return serveStaticFile(res, idx);
        return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    } catch {
      // fallthrough to file read
    }

    return serveStaticFile(res, abs);
  } catch (e) {
    return send(res, 500, 'Server error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, () => {
  const handbookNote = fs.existsSync(HANDBOOK_DIR)
    ? `Serving handbook assets from ${HANDBOOK_DIR}`
    : `Handbook assets dir not found: ${HANDBOOK_DIR}`;
  // eslint-disable-next-line no-console
  console.log(
    `Acknowledge dev server running on http://localhost:${PORT}\n${handbookNote}\n` +
    `Override with EMPLOYEE_HANDBOOK_DIR if needed.`
  );
});

