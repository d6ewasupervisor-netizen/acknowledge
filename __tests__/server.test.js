const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

// Import utility functions (server does not start when required as a module)
const { safeJoin, fileExists, walkFiles, MIME } = require('../server');

describe('safeJoin', () => {
  const base = '/srv/app';

  test('joins simple relative path', () => {
    expect(safeJoin(base, 'file.txt')).toBe(path.normalize('/srv/app/file.txt'));
  });

  test('joins nested relative path', () => {
    expect(safeJoin(base, 'sub/dir/file.txt')).toBe(
      path.normalize('/srv/app/sub/dir/file.txt')
    );
  });

  test('blocks directory traversal with ../', () => {
    expect(safeJoin(base, '../etc/passwd')).toBeNull();
  });

  test('blocks traversal that resolves above base', () => {
    expect(safeJoin(base, '../../root/.ssh/id_rsa')).toBeNull();
  });

  test('blocks traversal hidden inside nested path', () => {
    expect(safeJoin(base, 'a/b/../../../../etc/shadow')).toBeNull();
  });

  test('allows path that contains .. but stays within base', () => {
    const result = safeJoin(base, 'a/b/../b/file.txt');
    expect(result).toBe(path.normalize('/srv/app/a/b/file.txt'));
  });

  test('handles empty relative path', () => {
    // path.join('/srv/app', '') => '/srv/app' which does not start with '/srv/app/'
    expect(safeJoin(base, '')).toBeNull();
  });
});

describe('fileExists', () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ack-test-'));
    await fs.writeFile(path.join(tmpDir, 'exists.txt'), 'hello');
    await fs.mkdir(path.join(tmpDir, 'subdir'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns true for an existing file', async () => {
    expect(await fileExists(path.join(tmpDir, 'exists.txt'))).toBe(true);
  });

  test('returns false for a non-existent file', async () => {
    expect(await fileExists(path.join(tmpDir, 'nope.txt'))).toBe(false);
  });

  test('returns false for a directory', async () => {
    expect(await fileExists(path.join(tmpDir, 'subdir'))).toBe(false);
  });
});

describe('walkFiles', () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ack-walk-'));
    await fs.writeFile(path.join(tmpDir, 'root.txt'), '');
    await fs.mkdir(path.join(tmpDir, 'a'));
    await fs.writeFile(path.join(tmpDir, 'a', 'nested.txt'), '');
    await fs.mkdir(path.join(tmpDir, 'a', 'b'));
    await fs.writeFile(path.join(tmpDir, 'a', 'b', 'deep.txt'), '');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns all files recursively with posix-style relative paths', async () => {
    const files = await walkFiles(tmpDir);
    expect(files.sort()).toEqual(['a/b/deep.txt', 'a/nested.txt', 'root.txt']);
  });

  test('returns empty array for non-existent directory', async () => {
    const files = await walkFiles(path.join(tmpDir, 'does-not-exist'));
    expect(files).toEqual([]);
  });
});

describe('MIME type map', () => {
  test('maps .html to text/html', () => {
    expect(MIME['.html']).toBe('text/html; charset=utf-8');
  });

  test('maps .json to application/json', () => {
    expect(MIME['.json']).toBe('application/json; charset=utf-8');
  });

  test('maps .png to image/png (no charset)', () => {
    expect(MIME['.png']).toBe('image/png');
  });

  test('maps .svg to image/svg+xml', () => {
    expect(MIME['.svg']).toBe('image/svg+xml; charset=utf-8');
  });
});
