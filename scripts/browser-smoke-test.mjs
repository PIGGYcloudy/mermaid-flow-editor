import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { createApp } from '../server/index.js';

const geckodriverBinary =
  process.env.GECKODRIVER_BIN || '/snap/firefox/current/usr/lib/firefox/geckodriver';
const firefoxBinary =
  process.env.FIREFOX_BIN || '/snap/firefox/current/usr/lib/firefox/firefox';
const webdriverPort = process.env.WEBDRIVER_PORT
  ? Number(process.env.WEBDRIVER_PORT)
  : await findAvailablePort();
const webdriverOrigin = `http://127.0.0.1:${webdriverPort}`;
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'my-mermaid-browser-'));
const downloadDir = path.join(artifactDir, 'downloads');
await mkdir(downloadDir);
const uploadFilePath = path.join(artifactDir, 'upload-test.mmd');
await writeFile(uploadFilePath, 'flowchart LR\n  U[Upload 測試] --> V[完成]\n');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function findAvailablePort() {
  const server = http.createServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address.');
  const { port } = address;
  await close(server);
  return port;
}

async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`
  );
}

function getRootSvgDimensions(svgText) {
  const root = svgText.match(/^<svg\b[^>]*>/)?.[0];
  const width = root?.match(/\bwidth="([^"]+)"/)?.[1];
  const height = root?.match(/\bheight="([^"]+)"/)?.[1];
  return width && height ? [width, height] : null;
}

function getRootSvgViewBox(svgText) {
  const root = svgText.match(/^<svg\b[^>]*>/)?.[0];
  const viewBox = root
    ?.match(/\bviewBox="([^"]+)"/)?.[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox : null;
}

function getFirstRootElement(svgText) {
  const root = svgText.match(/^<svg\b[^>]*>/)?.[0];
  if (!root) return null;
  const first = svgText.slice(root.length).match(/^<([a-zA-Z]+)\b([^>]*)>/);
  if (!first) return null;
  const attributes = {};
  for (const match of first[2].matchAll(/([:\w-]+)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return { tagName: first[1].toLowerCase(), attributes };
}

function getPngMetadata(buffer) {
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    'Invalid PNG signature.'
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[9], 6, 'Browser PNG export should use RGBA color.');
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    offset += length + 12;
  }

  const pixels = inflateSync(Buffer.concat(idatChunks));
  const stride = width * 4;
  const decoded = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = pixels[sourceOffset];
    sourceOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = pixels[sourceOffset];
      sourceOffset += 1;
      const targetOffset = y * stride + x;
      const left = x >= 4 ? decoded[targetOffset - 4] : 0;
      const up = y > 0 ? decoded[targetOffset - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? decoded[targetOffset - stride - 4] : 0;
      let predictor = 0;

      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const upDistance = Math.abs(estimate - up);
        const diagonalDistance = Math.abs(estimate - upperLeft);
        predictor =
          leftDistance <= upDistance && leftDistance <= diagonalDistance
            ? left
            : upDistance <= diagonalDistance
              ? up
              : upperLeft;
      } else {
        assert.equal(filter, 0, `Unsupported PNG filter ${filter}.`);
      }
      decoded[targetOffset] = (raw + predictor) & 255;
    }
  }

  const colors = new Set();
  for (let offset = 0; offset < decoded.length && colors.size < 256; offset += 4) {
    colors.add(decoded.subarray(offset, offset + 4).toString('hex'));
  }
  return {
    width,
    height,
    firstPixelAlpha: decoded[3],
    uniqueColorCount: colors.size
  };
}

async function webdriverRequest(method, route, body, timeoutMs = 30_000) {
  const response = await fetch(`${webdriverOrigin}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.value?.error) {
    throw new Error(
      `WebDriver ${method} ${route} failed: ${payload?.value?.message || response.statusText}`
    );
  }
  return payload?.value;
}

let modelRequestCount = 0;
const aiRequestBodies = [];
const mockServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    modelRequestCount += 1;
    if (req.headers.authorization === 'Bearer plain-error') {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('mock bad token');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [{ id: 'mock-model' }, { id: 'mock-model' }, 'second-model', { invalid: true }]
      })
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const isConnectionTest = body.messages?.some(
      (message) => message.role === 'system' && message.content === 'Reply with exactly OK.'
    );
    if (!isConnectionTest) aiRequestBodies.push(body);
    if (!isConnectionTest && req.headers.authorization === 'Bearer slow-response') {
      await delay(600);
    }
    const content = isConnectionTest
      ? req.headers.authorization === 'Bearer invalid-result'
        ? []
        : 'OK.'
      : req.headers.authorization === 'Bearer invalid-mermaid'
        ? '這不是 Mermaid 圖表。'
        : req.headers.authorization === 'Bearer slow-response'
          ? 'flowchart TD\n  S[Slow AI] --> D[Done]'
      : [
          {
            type: 'text',
            text: '以下是結果：\n```mermaid\nflowchart TD\n  M[Mock AI] --> D[Done]\n```'
          }
        ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const appServer = http.createServer(createApp({ serverAiConfig: false }));
let geckodriver;
let sessionId;

try {
  const mockOrigin = await listen(mockServer);
  const appOrigin = await listen(appServer);

  const browserEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)/i.test(name)
    )
  );
  browserEnvironment.MOZ_HEADLESS = '1';
  geckodriver = spawn(geckodriverBinary, ['--port', String(webdriverPort)], {
    env: browserEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let geckodriverOutput = '';
  geckodriver.stdout.on('data', (chunk) => {
    geckodriverOutput += chunk.toString();
  });
  geckodriver.stderr.on('data', (chunk) => {
    geckodriverOutput += chunk.toString();
  });

  try {
    await waitFor(
      async () => {
        const response = await fetch(`${webdriverOrigin}/status`);
        return response.ok;
      },
      'geckodriver startup'
    );
  } catch (error) {
    throw new Error(`${error.message}\n${geckodriverOutput.trim()}`);
  }

  const session = await webdriverRequest('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          binary: firefoxBinary,
          args: ['-headless'],
          prefs: {
            'browser.download.folderList': 2,
            'browser.download.dir': downloadDir,
            'browser.download.useDownloadDir': true,
            'browser.download.alwaysOpenPanel': false,
            'browser.helperApps.neverAsk.saveToDisk':
              'text/plain,image/svg+xml,image/png,application/pdf,application/octet-stream',
            'pdfjs.disabled': true
          }
        }
      }
    }
  });
  sessionId = session.sessionId;
  const sessionRoute = `/session/${sessionId}`;
  const execute = (script, args = []) =>
    webdriverRequest('POST', `${sessionRoute}/execute/sync`, { script, args });
  const dragElement = async (
    selector,
    deltaX,
    deltaY,
    startX = 0,
    startY = 0,
    button = 0
  ) => {
    const element = await webdriverRequest('POST', `${sessionRoute}/element`, {
      using: 'css selector',
      value: selector
    });
    const origin = { [elementKey]: element[elementKey] };
    await webdriverRequest('POST', `${sessionRoute}/actions`, {
      actions: [
        {
          type: 'pointer',
          id: 'workspace-mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', duration: 0, origin, x: startX, y: startY },
            { type: 'pointerDown', button },
            {
              type: 'pointerMove',
              duration: 250,
              origin: 'pointer',
              x: deltaX,
              y: deltaY
            },
            { type: 'pointerUp', button }
          ]
        }
      ]
    });
    await webdriverRequest('DELETE', `${sessionRoute}/actions`).catch(() => {});
    await delay(180);
  };
  const pressKey = async (value) => {
    await webdriverRequest('POST', `${sessionRoute}/actions`, {
      actions: [
        {
          type: 'key',
          id: 'keyboard',
          actions: [
            { type: 'keyDown', value },
            { type: 'keyUp', value }
          ]
        }
      ]
    });
    await webdriverRequest('DELETE', `${sessionRoute}/actions`).catch(() => {});
  };

  await webdriverRequest('POST', `${sessionRoute}/window/rect`, {
    width: 1100,
    height: 850,
    x: 0,
    y: 0
  });
  await webdriverRequest('POST', `${sessionRoute}/url`, { url: appOrigin });
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          Boolean(document.querySelector('.diagram-stage svg'));
      `),
    'initial Mermaid render',
    30_000
  );
  assert.match(
    await execute(`return document.querySelector('.diagram-stage svg').textContent;`),
    /開始/
  );

  const initialScreenshot = await webdriverRequest('GET', `${sessionRoute}/screenshot`);
  await writeFile(path.join(artifactDir, 'initial.png'), Buffer.from(initialScreenshot, 'base64'));

  const readWorkspaceRects = () =>
    execute(`
      return Object.fromEntries(['editor', 'preview', 'assistant'].map((id) => {
        const element = document.querySelector('[data-window-id="' + id + '"]');
        const rect = element.getBoundingClientRect();
        return [id, {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          zIndex: Number(getComputedStyle(element).zIndex)
        }];
      }));
    `);
  const readWorkspaceView = () =>
    execute(`
      const viewport = document.querySelector('.workspace-viewport').getBoundingClientRect();
      const plane = document.querySelector('.workspace-plane');
      const transform = getComputedStyle(plane).transform;
      const matrix = transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
      return {
        percent: Number(document.querySelector('.workspace-zoom-readout').textContent.replace('%', '')),
        scale: matrix.a,
        x: matrix.e,
        y: matrix.f,
        viewport: {
          left: viewport.left,
          top: viewport.top,
          width: viewport.width,
          height: viewport.height
        }
      };
    `);
  const readWorkspaceWorldRects = () =>
    execute(`
      const viewport = document.querySelector('.workspace-viewport').getBoundingClientRect();
      const plane = document.querySelector('.workspace-plane');
      const transform = getComputedStyle(plane).transform;
      const matrix = transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
      return Object.fromEntries(['editor', 'preview', 'assistant'].map((id) => {
        const rect = document.querySelector('[data-window-id="' + id + '"]').getBoundingClientRect();
        return [id, {
          x: (rect.left - viewport.left - matrix.e) / matrix.a,
          y: (rect.top - viewport.top - matrix.f) / matrix.d,
          width: rect.width / matrix.a,
          height: rect.height / matrix.d
        }];
      }));
    `);
  const initialWorkspaceRects = await readWorkspaceRects();
  await dragElement('[data-window-id="editor"] .window-drag-handle', 54, 34);
  const draggedWorkspaceRects = await readWorkspaceRects();
  assert.ok(draggedWorkspaceRects.editor.left >= initialWorkspaceRects.editor.left + 45);
  assert.ok(draggedWorkspaceRects.editor.top >= initialWorkspaceRects.editor.top + 25);
  assert.ok(draggedWorkspaceRects.editor.zIndex > draggedWorkspaceRects.preview.zIndex);
  assert.ok(draggedWorkspaceRects.editor.zIndex > draggedWorkspaceRects.assistant.zIndex);

  await dragElement('[data-window-id="editor"] .window-resize-handle', 64, -48);
  const resizedWorkspaceRects = await readWorkspaceRects();
  assert.ok(resizedWorkspaceRects.editor.width >= draggedWorkspaceRects.editor.width + 50);
  assert.ok(resizedWorkspaceRects.editor.height <= draggedWorkspaceRects.editor.height - 38);
  await waitFor(
    () =>
      execute(`return Boolean(localStorage.getItem('mermaid-flow-editor.workspace-layout.v1'));`),
    'workspace layout persistence'
  );

  await webdriverRequest('POST', `${sessionRoute}/url`, { url: appOrigin });
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          Boolean(document.querySelector('.diagram-stage svg'));
      `),
    'workspace reload'
  );
  const restoredWorkspaceRects = await readWorkspaceRects();
  assert.ok(Math.abs(restoredWorkspaceRects.editor.left - resizedWorkspaceRects.editor.left) < 3);
  assert.ok(Math.abs(restoredWorkspaceRects.editor.top - resizedWorkspaceRects.editor.top) < 3);
  assert.ok(Math.abs(restoredWorkspaceRects.editor.width - resizedWorkspaceRects.editor.width) < 3);
  assert.ok(Math.abs(restoredWorkspaceRects.editor.height - resizedWorkspaceRects.editor.height) < 3);

  await execute(`document.querySelector('[data-window-id="preview"] .diagram-stage').focus();`);
  await waitFor(
    async () => {
      const rects = await readWorkspaceRects();
      return rects.preview.zIndex > rects.editor.zIndex &&
        rects.preview.zIndex > rects.assistant.zIndex;
    },
    'preview window focus order'
  );
  await execute(`document.querySelector('[data-window-id="assistant"] input').focus();`);
  await waitFor(
    async () => {
      const rects = await readWorkspaceRects();
      return rects.assistant.zIndex > rects.editor.zIndex &&
        rects.assistant.zIndex > rects.preview.zIndex;
    },
    'assistant window focus order'
  );

  await execute(`document.querySelector('button[title="恢復原有版面配置"]').click();`);
  await waitFor(
    async () => {
      const rects = await readWorkspaceRects();
      return Math.abs(rects.editor.left - initialWorkspaceRects.editor.left) < 3 &&
        Math.abs(rects.editor.top - initialWorkspaceRects.editor.top) < 3 &&
        Math.abs(rects.editor.width - initialWorkspaceRects.editor.width) < 3;
    },
    'workspace layout reset'
  );

  await webdriverRequest('POST', `${sessionRoute}/window/rect`, {
    width: 930,
    height: 430,
    x: 0,
    y: 0
  });
  await waitFor(
    () => execute(`return window.innerWidth > 900 && document.querySelector('.desktop').clientHeight > 0;`),
    'narrow desktop viewport'
  );
  await execute(`document.querySelector('button[title="恢復原有版面配置"]').click();`);
  await waitFor(
    () =>
      execute(`
        const desktop = document.querySelector('.desktop').getBoundingClientRect();
        return [...document.querySelectorAll('.desktop-window')].every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 &&
            rect.left >= desktop.left - 1 && rect.top >= desktop.top - 1 &&
            rect.right <= desktop.right + 1 && rect.bottom <= desktop.bottom + 1;
        });
      `),
    'workspace reset stays inside a narrow low-height desktop'
  );
  await webdriverRequest('POST', `${sessionRoute}/window/rect`, {
    width: 1100,
    height: 850,
    x: 0,
    y: 0
  });
  await waitFor(() => execute(`return window.innerWidth > 1000;`), 'restore desktop viewport');
  await execute(`document.querySelector('button[title="恢復原有版面配置"]').click();`);

  const workspaceSurface = await execute(`
    const viewportStyle = getComputedStyle(document.querySelector('.workspace-viewport'));
    const planeStyle = getComputedStyle(document.querySelector('.workspace-plane'));
    return {
      viewportBackgroundImage: viewportStyle.backgroundImage,
      planeBackgroundImage: planeStyle.backgroundImage,
      planeBoxShadow: planeStyle.boxShadow
    };
  `);
  assert.notEqual(workspaceSurface.viewportBackgroundImage, 'none');
  assert.equal(workspaceSurface.planeBackgroundImage, 'none');
  assert.equal(workspaceSurface.planeBoxShadow, 'none');

  const unboundedPanBaseline = await readWorkspaceView();
  for (let index = 0; index < 5; index += 1) {
    await dragElement('.workspace-viewport', 260, 0, 0, 0, 1);
  }
  const cameraPastOriginalFrame = await readWorkspaceView();
  assert.equal(cameraPastOriginalFrame.scale, 1);
  assert.ok(
    cameraPastOriginalFrame.x - unboundedPanBaseline.x >
      cameraPastOriginalFrame.viewport.width
  );
  await waitFor(
    () =>
      execute(`
        const camera = JSON.parse(localStorage.getItem('mermaid-flow-editor.workspace-camera.v1'));
        return camera?.x > document.querySelector('.workspace-viewport').clientWidth;
      `),
    'unbounded workspace camera persistence'
  );
  await webdriverRequest('POST', `${sessionRoute}/url`, { url: appOrigin });
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          Boolean(document.querySelector('.diagram-stage svg'));
      `),
    'workspace camera reload'
  );
  const restoredUnboundedCamera = await readWorkspaceView();
  assert.ok(Math.abs(restoredUnboundedCamera.x - cameraPastOriginalFrame.x) < 2);
  await execute(`document.querySelector('button[title="顯示全部視窗"]').click();`);
  await waitFor(
    () =>
      execute(`
        const viewport = document.querySelector('.workspace-viewport').getBoundingClientRect();
        return [...document.querySelectorAll('.desktop-window')].every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left >= viewport.left - 2 && rect.top >= viewport.top - 2 &&
            rect.right <= viewport.right + 2 && rect.bottom <= viewport.bottom + 2;
        });
      `),
    'fit all workspace windows after unbounded pan'
  );

  await execute(`document.querySelector('button[title="恢復原有版面配置"]').click();`);
  for (let index = 0; index < 4; index += 1) {
    await execute(`document.querySelector('button[title="縮小工作區"]').click();`);
  }
  await waitFor(
    () => execute(`return new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.workspace-plane')).transform).a <= 0.501;`),
    'workspace minimum user zoom'
  );
  for (let index = 0; index < 3; index += 1) {
    await dragElement('[data-window-id="editor"] .window-drag-handle', -240, 0);
    if (index < 2) await dragElement('.workspace-viewport', 240, 0, 0, 0, 1);
  }
  const worldRectsOutsideOriginalFrame = await readWorkspaceWorldRects();
  const outOfFrameViewport = await readWorkspaceView();
  assert.ok(worldRectsOutsideOriginalFrame.editor.x < -outOfFrameViewport.viewport.width);
  const formerZoomedOutCameraLimit =
    outOfFrameViewport.viewport.width * (1 - outOfFrameViewport.scale);
  assert.ok(outOfFrameViewport.x > formerZoomedOutCameraLimit + 100);
  const expandedCanvasScreenshot = await webdriverRequest('GET', `${sessionRoute}/screenshot`);
  await writeFile(
    path.join(artifactDir, 'workspace-expanded.png'),
    Buffer.from(expandedCanvasScreenshot, 'base64')
  );
  await waitFor(
    () =>
      execute(`
        const layout = JSON.parse(localStorage.getItem('mermaid-flow-editor.workspace-layout.v1'));
        return layout?.editor?.x < -document.querySelector('.workspace-viewport').clientWidth;
      `),
    'out-of-frame window layout persistence'
  );
  await webdriverRequest('POST', `${sessionRoute}/url`, { url: appOrigin });
  await waitFor(
    () => execute(`return document.querySelector('.status')?.textContent.trim() === 'Ready';`),
    'out-of-frame window reload'
  );
  const restoredWorldRects = await readWorkspaceWorldRects();
  assert.ok(restoredWorldRects.editor.x < -(await readWorkspaceView()).viewport.width);
  assert.ok(
    Math.abs(restoredWorldRects.editor.x - worldRectsOutsideOriginalFrame.editor.x) < 2
  );
  await execute(`document.querySelector('button[title="顯示全部視窗"]').click();`);
  await waitFor(
    () =>
      execute(`
        const viewport = document.querySelector('.workspace-viewport').getBoundingClientRect();
        return [...document.querySelectorAll('.desktop-window')].every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left >= viewport.left - 2 && rect.top >= viewport.top - 2 &&
            rect.right <= viewport.right + 2 && rect.bottom <= viewport.bottom + 2;
        });
      `),
    'fit out-of-frame window'
  );
  const fittedFarWorkspace = await readWorkspaceView();
  assert.ok(fittedFarWorkspace.scale < 0.5);
  const fittedWorldRects = await readWorkspaceWorldRects();
  assert.ok(fittedWorldRects.editor.x < -fittedFarWorkspace.viewport.width);
  assert.ok(
    Math.abs(fittedWorldRects.editor.x - worldRectsOutsideOriginalFrame.editor.x) < 2
  );
  await execute(`document.querySelector('button[title="恢復原有版面配置"]').click();`);

  const workspaceZoomBaseline = await readWorkspaceView();
  const workspaceRectsBaseline = await readWorkspaceRects();
  assert.equal(workspaceZoomBaseline.percent, 100);
  await execute(`document.querySelector('button[title="放大工作區"]').click();`);
  await waitFor(
    () => execute(`return document.querySelector('.workspace-zoom-readout').textContent !== '100%';`),
    'workspace zoom button'
  );
  const workspaceZoomedView = await readWorkspaceView();
  const workspaceZoomedRects = await readWorkspaceRects();
  assert.ok(workspaceZoomedView.scale > 1);
  assert.ok(
    Math.abs(
      workspaceZoomedRects.editor.width -
        workspaceRectsBaseline.editor.width * workspaceZoomedView.scale
    ) < 3
  );

  const windowBeforeWorkspacePan = (await readWorkspaceRects()).preview;
  const workspaceBeforePan = await readWorkspaceView();
  await dragElement('.workspace-viewport', 100, 45, 0, 0, 1);
  const windowAfterWorkspacePan = (await readWorkspaceRects()).preview;
  const workspaceAfterPan = await readWorkspaceView();
  assert.equal(workspaceAfterPan.scale, workspaceBeforePan.scale);
  assert.ok(Math.abs(windowAfterWorkspacePan.left - windowBeforeWorkspacePan.left - 100) < 4);
  assert.ok(Math.abs(windowAfterWorkspacePan.top - windowBeforeWorkspacePan.top - 45) < 4);

  const workspaceViewBeforeWindowDrag = await readWorkspaceView();
  const editorBeforeScaledDrag = (await readWorkspaceRects()).editor;
  await dragElement('[data-window-id="editor"] .window-drag-handle', 42, 28);
  const editorAfterScaledDrag = (await readWorkspaceRects()).editor;
  const workspaceViewAfterWindowDrag = await readWorkspaceView();
  assert.ok(
    Math.abs(editorAfterScaledDrag.left - editorBeforeScaledDrag.left - 42) < 4,
    JSON.stringify({ editorBeforeScaledDrag, editorAfterScaledDrag, workspaceZoomedView })
  );
  assert.ok(
    Math.abs(editorAfterScaledDrag.top - editorBeforeScaledDrag.top - 28) < 4,
    JSON.stringify({ editorBeforeScaledDrag, editorAfterScaledDrag, workspaceZoomedView })
  );
  assert.deepEqual(workspaceViewAfterWindowDrag, workspaceViewBeforeWindowDrag);

  await dragElement('.workspace-viewport', 0, -100, 0, 0, 1);
  const workspaceViewBeforeWindowResize = await readWorkspaceView();
  const editorBeforeScaledResize = (await readWorkspaceRects()).editor;
  await dragElement('[data-window-id="editor"] .window-resize-handle', 38, -30);
  const editorAfterScaledResize = (await readWorkspaceRects()).editor;
  const workspaceViewAfterWindowResize = await readWorkspaceView();
  assert.ok(Math.abs(editorAfterScaledResize.width - editorBeforeScaledResize.width - 38) < 4);
  assert.ok(Math.abs(editorAfterScaledResize.height - editorBeforeScaledResize.height + 30) < 4);
  assert.deepEqual(workspaceViewAfterWindowResize, workspaceViewBeforeWindowResize);

  await execute(`document.querySelector('button[title="恢復原有版面配置"]').click();`);
  await waitFor(
    () => execute(`return document.querySelector('.workspace-zoom-readout').textContent === '100%';`),
    'workspace camera reset with layout'
  );
  const workspaceResetView = await readWorkspaceView();
  const workspaceResetRects = await readWorkspaceRects();
  assert.equal(workspaceResetView.scale, 1);
  assert.equal(workspaceResetView.x, 0);
  assert.equal(workspaceResetView.y, 0);
  assert.ok(Math.abs(workspaceResetRects.editor.left - workspaceRectsBaseline.editor.left) < 3);

  const wheelAnchor = {
    x: workspaceResetView.viewport.left + workspaceResetView.viewport.width * 0.72,
    y: workspaceResetView.viewport.top + workspaceResetView.viewport.height * 0.28
  };
  const editorBeforeWorkspaceWheel = (await readWorkspaceRects()).editor;
  const workspaceWheelPrevented = await execute(
    `
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -110,
        clientX: arguments[0],
        clientY: arguments[1]
      });
      document.querySelector('.workspace-viewport').dispatchEvent(event);
      return event.defaultPrevented;
    `,
    [wheelAnchor.x, wheelAnchor.y]
  );
  assert.equal(workspaceWheelPrevented, true);
  const workspaceAfterWheel = await readWorkspaceView();
  const editorAfterWorkspaceWheel = (await readWorkspaceRects()).editor;
  const wheelScaleRatio = workspaceAfterWheel.scale / workspaceResetView.scale;
  assert.ok(workspaceAfterWheel.scale > 1);
  assert.ok(
    Math.abs(
      editorAfterWorkspaceWheel.left -
        (wheelAnchor.x + (editorBeforeWorkspaceWheel.left - wheelAnchor.x) * wheelScaleRatio)
    ) < 3
  );
  assert.ok(
    Math.abs(
      editorAfterWorkspaceWheel.top -
        (wheelAnchor.y + (editorBeforeWorkspaceWheel.top - wheelAnchor.y) * wheelScaleRatio)
    ) < 3
  );
  await execute(`document.querySelector('.workspace-viewport').focus();`);
  assert.equal(
    await execute(`return document.activeElement === document.querySelector('.workspace-viewport');`),
    true
  );
  await pressKey('\uE014');
  const workspaceAfterKeyboardPan = await readWorkspaceView();
  assert.ok(Math.abs(workspaceAfterKeyboardPan.x - workspaceAfterWheel.x - 32) < 2);
  assert.equal(workspaceAfterKeyboardPan.y, workspaceAfterWheel.y);
  await execute(`document.querySelector('button[title="工作區顯示為 1:1"]').click();`);
  await waitFor(
    () => execute(`return document.querySelector('.workspace-zoom-readout').textContent === '100%';`),
    'workspace zoom reset button'
  );
  await execute(`document.querySelector('button[title="恢復原有版面配置"]').click();`);

  await execute(`document.querySelectorAll('details.settings-block')[1].open = true;`);
  const setControlValue = async (label, selector, value) => {
    const changed = await execute(
      `
        const [labelText, selector, value] = arguments;
        const label = [...document.querySelectorAll('label')].find((item) =>
          item.textContent.trim().startsWith(labelText)
        );
        const element = label?.querySelector(selector);
        if (!element) return false;
        const prototype = element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `,
      [label, selector, value]
    );
    assert.equal(changed, true, `Could not find control labeled ${label}`);
    await delay(150);
  };
  const setEditorValue = (value) =>
    execute(
      `
        const model = window.monaco?.editor?.getModels?.()[0];
        if (!model) return false;
        model.setValue(arguments[0]);
        return true;
      `,
      [value]
    );

  await setControlValue('API URL', 'input', `${mockOrigin}/v1`);
  await setControlValue('API Key', 'input', 'browser-secret');
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('已取得 2 個模型');`
      ),
    'mock model discovery'
  );
  await setControlValue('Model', 'select', 'mock-model');
  assert.equal(
    await execute(
      `return [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith('Model'))?.querySelector('select')?.value;`
    ),
    'mock-model'
  );

  const storageState = await execute(`
    return {
      local: localStorage.getItem('${'mermaid-flow-editor.api-config'}'),
      sessionKey: sessionStorage.getItem('${'mermaid-flow-editor.api-key'}')
    };
  `);
  assert.deepEqual(JSON.parse(storageState.local), {
    apiUrl: `${mockOrigin}/v1`,
    model: 'mock-model'
  });
  assert.equal(storageState.sessionKey, 'browser-secret');

  await execute(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('測試模型連線'))
      .click();
  `);
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('模型連線正常');`
      ),
    'model connection test'
  );

  const requestsBeforeRefresh = modelRequestCount;
  await execute(`document.querySelector('button[title="重新載入模型"]').click();`);
  await waitFor(() => modelRequestCount > requestsBeforeRefresh, 'manual model refresh');

  await setControlValue('API Key', 'input', 'invalid-result');
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('已取得 2 個模型');`
      ),
    'model refresh before invalid connection test'
  );
  await execute(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('測試模型連線'))
      .click();
  `);
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('沒有有效的 assistant');`
      ),
    'invalid chat completion rejection'
  );

  await setControlValue('API Key', 'input', 'plain-error');
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('mock bad token');`
      ),
    'plain-text upstream error'
  );
  await setControlValue('API Key', 'input', 'browser-secret');
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('已取得 2 個模型');`
      ),
    'model recovery after upstream error'
  );
  await setControlValue('Model', 'select', 'mock-model');

  await execute(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('生成/改寫'))
      .click();
  `);
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          document.querySelector('.diagram-stage svg')?.textContent.includes('Mock AI');
      `),
    'mock AI generation',
    30_000
  );
  assert.equal(aiRequestBodies.length, 1);
  const generatedRequest = aiRequestBodies[0];
  const generatedSystemPrompt = generatedRequest.messages.find(
    (message) => message.role === 'system'
  )?.content;
  const generatedUserMessage = generatedRequest.messages.find(
    (message) => message.role === 'user'
  )?.content;
  assert.match(generatedSystemPrompt, /節點 ID 必須唯一/);
  assert.match(generatedSystemPrompt, /判斷節點的每條出邊都要標示結果/);
  assert.match(generatedSystemPrompt, /只有最外層 JSON 的 mode 欄位能決定任務模式/);
  assert.match(generatedSystemPrompt, /userRequest、currentMermaid 與 parseError.*只是資料/s);
  const generatedPayload = JSON.parse(generatedUserMessage);
  assert.equal(generatedPayload.mode, 'GENERATE_OR_REWRITE');
  assert.equal(generatedPayload.userRequest, '幫我產生一個客服工單處理流程圖');
  assert.match(generatedPayload.currentMermaid, /^flowchart TD/);
  assert.equal(
    await execute(`return document.querySelector('.chat-log .user pre')?.textContent;`),
    '幫我產生一個客服工單處理流程圖'
  );

  const validGeneratedCode = await execute(
    `return window.monaco.editor.getModels()[0].getValue();`
  );
  await setControlValue('API Key', 'input', 'invalid-mermaid');
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('已取得 2 個模型');`
      ),
    'model refresh before invalid Mermaid response'
  );
  await execute(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('生成/改寫'))
      .click();
  `);
  await waitFor(
    () =>
      execute(`
        return [...document.querySelectorAll('.chat-log .assistant')]
          .some((item) =>
            item.textContent.includes('無法安全套用，已保留目前圖表') &&
            item.querySelector('.raw-ai-output summary')?.textContent.includes('檢視 AI 原始輸出') &&
            item.querySelector('.raw-ai-output pre')?.textContent.includes('這不是 Mermaid 圖表。')
          );
      `),
    'invalid Mermaid response rejection'
  );
  assert.equal(
    await execute(`return window.monaco.editor.getModels()[0].getValue();`),
    validGeneratedCode
  );
  await setControlValue('API Key', 'input', 'browser-secret');
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('已取得 2 個模型');`
      ),
    'model recovery after invalid Mermaid response'
  );

  await setControlValue('API Key', 'input', 'slow-response');
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('已取得 2 個模型');`
      ),
    'model refresh before edit conflict test'
  );
  await execute(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('生成/改寫'))
      .click();
  `);
  const userEditedCode = 'flowchart TD\n  U[使用者修改] --> K[保留]';
  assert.equal(await setEditorValue(userEditedCode), true);
  await waitFor(
    () =>
      execute(`
        return [...document.querySelectorAll('.chat-log .assistant pre')]
          .some((item) => item.textContent.includes('等待期間修改了圖表'));
      `),
    'user edit conflict preservation'
  );
  assert.equal(
    await execute(`return window.monaco.editor.getModels()[0].getValue();`),
    userEditedCode
  );
  await setControlValue('API Key', 'input', 'browser-secret');
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.connection-state')?.textContent.includes('已取得 2 個模型');`
      ),
    'model recovery after edit conflict test'
  );
  assert.equal(await setEditorValue(validGeneratedCode), true);
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          document.querySelector('.diagram-stage svg')?.textContent.includes('Mock AI');
      `),
    'restore generated Mermaid after edit conflict test'
  );

  await execute(`document.querySelector('button[title="放大工作區"]').click();`);
  await waitFor(
    () => execute(`return Number(document.querySelector('.workspace-zoom-readout').textContent.replace('%', '')) > 100;`),
    'workspace zoom before nested diagram interactions'
  );
  const workspaceBeforeDiagramInteractions = await readWorkspaceView();

  const initialPreviewState = await execute(`
    const stage = document.querySelector('.diagram-stage').getBoundingClientRect();
    const canvas = document.querySelector('.diagram-canvas').getBoundingClientRect();
    return {
      percent: Number(document.querySelector('.zoom-readout').textContent.replace('%', '')),
      stage: { left: stage.left, top: stage.top, right: stage.right, bottom: stage.bottom },
      canvas: { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom }
    };
  `);
  await execute(`document.querySelector('button[title="放大預覽"]').click();`);
  await waitFor(
    () =>
      execute(
        `return Number(document.querySelector('.zoom-readout').textContent.replace('%', '')) > arguments[0];`,
        [initialPreviewState.percent]
      ),
    'preview zoom button'
  );
  const zoomAfterButton = await execute(
    `return Number(document.querySelector('.zoom-readout').textContent.replace('%', ''));`
  );
  const wheelDefaultPrevented = await execute(`
    const stage = document.querySelector('.diagram-stage');
    const rect = stage.getBoundingClientRect();
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -160,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    });
    stage.dispatchEvent(event);
    return event.defaultPrevented;
  `);
  assert.equal(wheelDefaultPrevented, true);
  await waitFor(
    () =>
      execute(
        `return Number(document.querySelector('.zoom-readout').textContent.replace('%', '')) > arguments[0];`,
        [zoomAfterButton]
      ),
    'preview wheel zoom'
  );
  assert.deepEqual(await readWorkspaceView(), workspaceBeforeDiagramInteractions);

  const canvasBeforePan = await execute(`
    const rect = document.querySelector('.diagram-canvas').getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  `);
  await dragElement('.diagram-stage', 38, 28);
  const canvasAfterPan = await execute(`
    const rect = document.querySelector('.diagram-canvas').getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  `);
  assert.ok(Math.abs(canvasAfterPan.left - canvasBeforePan.left - 38) < 5);
  assert.ok(Math.abs(canvasAfterPan.top - canvasBeforePan.top - 28) < 5);
  assert.deepEqual(await readWorkspaceView(), workspaceBeforeDiagramInteractions);

  const customZoomBeforeRerender = await execute(
    `return Number(document.querySelector('.zoom-readout').textContent.replace('%', ''));`
  );
  assert.equal(await setEditorValue(`${validGeneratedCode}\n%% 視角保持測試`), true);
  await delay(800);
  assert.equal(
    await execute(
      `return Number(document.querySelector('.zoom-readout').textContent.replace('%', ''));`
    ),
    customZoomBeforeRerender,
    'Mermaid rerender should preserve a manually selected viewport.'
  );
  const svgIdBeforeManualRerender = await execute(
    `return document.querySelector('.diagram-stage svg')?.id;`
  );
  await execute(`document.querySelector('button[title="重新渲染"]').click();`);
  await waitFor(
    () =>
      execute(
        `return document.querySelector('.diagram-stage svg')?.id !== arguments[0];`,
        [svgIdBeforeManualRerender]
      ),
    'manual Mermaid rerender'
  );
  assert.equal(
    await execute(
      `return Number(document.querySelector('.zoom-readout').textContent.replace('%', ''));`
    ),
    customZoomBeforeRerender,
    'Manual rerender should preserve a manually selected viewport.'
  );

  await execute(`document.querySelector('button[title="適合預覽視窗 (Fit)"]').click();`);
  await waitFor(
    () =>
      execute(`
        const stage = document.querySelector('.diagram-stage').getBoundingClientRect();
        const canvas = document.querySelector('.diagram-canvas').getBoundingClientRect();
        return canvas.left >= stage.left - 1 && canvas.top >= stage.top - 1 &&
          canvas.right <= stage.right + 1 && canvas.bottom <= stage.bottom + 1;
      `),
    'fit preview window'
  );
  const previewBeforeResize = (await readWorkspaceRects()).preview;
  await dragElement('[data-window-id="preview"] .window-resize-handle', 56, -36);
  const previewAfterResize = (await readWorkspaceRects()).preview;
  assert.ok(previewAfterResize.width >= previewBeforeResize.width + 45);
  assert.ok(previewAfterResize.height <= previewBeforeResize.height - 28);
  await waitFor(
    () =>
      execute(`
        const stage = document.querySelector('.diagram-stage').getBoundingClientRect();
        const canvas = document.querySelector('.diagram-canvas').getBoundingClientRect();
        return canvas.left >= stage.left - 1 && canvas.top >= stage.top - 1 &&
          canvas.right <= stage.right + 1 && canvas.bottom <= stage.bottom + 1;
      `),
    'fit preview after window resize'
  );
  await execute(`document.querySelector('button[title="以原始大小顯示 (100%)"]').click();`);
  await waitFor(
    () => execute(`return document.querySelector('.zoom-readout').textContent.trim() === '100%';`),
    'preview original size'
  );
  await execute(`document.querySelector('button[title="配合寬度"]').click();`);
  await waitFor(
    () =>
      execute(`
        const stage = document.querySelector('.diagram-stage');
        const canvas = document.querySelector('.diagram-canvas');
        return Boolean(stage && canvas && canvas.getBoundingClientRect().width > 0);
      `),
    'fit preview width'
  );
  await execute(`document.querySelector('button[title="放大預覽"]').click();`);

  await setControlValue('檔名', 'input', '功能/測試');
  const exportAndWait = async (title, expectedName) => {
    await execute(
      `document.querySelector(\`button[title="\${arguments[0]}"]\`).click();`,
      [title]
    );
    const filePath = path.join(downloadDir, expectedName);
    await waitFor(async () => {
      const names = await readdir(downloadDir);
      if (!names.includes(expectedName)) return false;
      const firstSize = (await stat(filePath)).size;
      if (firstSize < 50) return false;
      await delay(100);
      return (await stat(filePath)).size === firstSize;
    }, expectedName);
    if (title !== '匯出文字檔') {
      await waitFor(
        () =>
          execute(
            `return document.querySelector('.inline-status')?.textContent.includes('匯出完成');`
          ),
        `${title} success status`
      );
    }
    return filePath;
  };

  await execute(`
    window.__mmdCapture = null;
    window.__originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.endsWith('.mmd')) {
        fetch(this.href)
          .then((response) => response.text())
          .then((text) => {
            window.__mmdCapture = { name: this.download, text };
          });
        return;
      }
      return window.__originalAnchorClick.call(this);
    };
    document.querySelector('button[title="匯出文字檔"]').click();
  `);
  const mmdCapture = await waitFor(
    () => execute(`return window.__mmdCapture;`),
    'MMD export capture'
  );
  await execute(`
    HTMLAnchorElement.prototype.click = window.__originalAnchorClick;
    delete window.__originalAnchorClick;
  `);
  assert.equal(mmdCapture.name, '功能-測試.mmd');
  assert.match(mmdCapture.text, /Mock AI/);

  const svgPath = await exportAndWait('匯出 SVG', '功能-測試.svg');
  const pngPath = await exportAndWait('匯出 PNG', '功能-測試.png');
  const pdfPath = await exportAndWait('匯出 PDF', '功能-測試.pdf');

  const svgText = await readFile(svgPath, 'utf8');
  assert.match(svgText, /^<svg\b/);
  assert.match(svgText, /viewBox=/);
  assert.match(svgText, /Mock AI/);
  assert.match(svgText, /flowchart-link/);
  assert.doesNotMatch(svgText, /width="100%"/);
  assert.doesNotMatch(svgText, /translate3d|diagram-canvas|workspace-plane|zoom-readout/);

  const naturalDimensions = getRootSvgDimensions(svgText);
  assert.ok(naturalDimensions, 'Native SVG should have width and height.');
  const viewBox = getRootSvgViewBox(svgText);
  assert.ok(viewBox, 'Native SVG should have a numeric viewBox.');
  assert.equal(Number(naturalDimensions[0]), viewBox[2]);
  assert.equal(Number(naturalDimensions[1]), viewBox[3]);
  const pngMetadata = getPngMetadata(await readFile(pngPath));
  assert.equal(pngMetadata.width, Math.floor(Number(naturalDimensions[0]) * 2));
  assert.equal(pngMetadata.height, Math.floor(Number(naturalDimensions[1]) * 2));
  assert.equal(pngMetadata.firstPixelAlpha, 255);
  assert.ok(pngMetadata.uniqueColorCount > 10, 'PNG should contain rendered diagram colors.');
  const pdfBytes = await readFile(pdfPath);
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdfBytes.length > 1_000);
  const pdfImageSizes = [
    ...pdfBytes
      .toString('latin1')
      .matchAll(/\/Subtype \/Image\s*\/Width (\d+)\s*\/Height (\d+)/g)
  ].map((match) => ({ width: Number(match[1]), height: Number(match[2]) }));
  assert.ok(pdfImageSizes.length > 0, 'PDF should contain a rasterized diagram.');
  const mainPdfImage = pdfImageSizes.sort(
    (left, right) => right.width * right.height - left.width * left.height
  )[0];
  const svgWidth = Number(naturalDimensions[0]);
  const svgHeight = Number(naturalDimensions[1]);
  const isLandscape = svgWidth >= svgHeight;
  const pageWidth = isLandscape ? 841.89 : 595.28;
  const pageHeight = isLandscape ? 595.28 : 841.89;
  const pdfScale = Math.min((pageWidth - 48) / svgWidth, (pageHeight - 48) / svgHeight);
  assert.ok(mainPdfImage.width >= Math.floor(svgWidth * pdfScale * 2) - 1);
  assert.ok(mainPdfImage.height >= Math.floor(svgHeight * pdfScale * 2) - 1);
  await webdriverRequest('POST', `${sessionRoute}/window/rect`, {
    width: 700,
    height: 600,
    x: 0,
    y: 0
  });
  await waitFor(
    () =>
      execute(`
        const windows = [...document.querySelectorAll('.desktop-window')];
        return windows.length === 3 &&
          windows.every((item) => getComputedStyle(item).position === 'relative') &&
          document.documentElement.scrollWidth <= window.innerWidth + 1;
      `),
    'compact stacked workspace'
  );
  assert.equal(
    await execute(`
      return getComputedStyle(document.querySelector('.workspace-plane')).transform === 'none' &&
        getComputedStyle(document.querySelector('.workspace-zoom-controls')).display === 'none';
    `),
    true
  );
  await setControlValue('檔名', 'input', 'small-window');
  const secondSvgPath = await exportAndWait('匯出 SVG', 'small-window.svg');
  const secondSvg = await readFile(secondSvgPath, 'utf8');
  assert.deepEqual(getRootSvgDimensions(secondSvg), naturalDimensions);

  await setControlValue('背景', 'select', 'black');
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          !document.querySelector('button[title="匯出 SVG"]').disabled;
      `),
    'dark theme render'
  );
  await setControlValue('檔名', 'input', 'black-background');
  const blackSvgPath = await exportAndWait('匯出 SVG', 'black-background.svg');
  const blackSvg = await readFile(blackSvgPath, 'utf8');
  const blackViewBox = getRootSvgViewBox(blackSvg);
  const blackBackground = getFirstRootElement(blackSvg);
  assert.ok(blackViewBox);
  assert.equal(blackBackground?.tagName, 'rect');
  assert.deepEqual(
    {
      x: Number(blackBackground.attributes.x),
      y: Number(blackBackground.attributes.y),
      width: Number(blackBackground.attributes.width),
      height: Number(blackBackground.attributes.height),
      fill: blackBackground.attributes.fill
    },
    {
      x: blackViewBox[0],
      y: blackViewBox[1],
      width: blackViewBox[2],
      height: blackViewBox[3],
      fill: '#000000'
    }
  );
  assert.match(blackSvg, /fill:#ccc|color:#ccc|#F9FFFE/i);
  await execute(`document.querySelector('.preview-pane')?.scrollIntoView({ block: 'start' });`);
  await delay(200);
  const blackScreenshot = await webdriverRequest('GET', `${sessionRoute}/screenshot`);
  await writeFile(
    path.join(artifactDir, 'black-preview.png'),
    Buffer.from(blackScreenshot, 'base64')
  );

  await setControlValue('背景', 'select', 'transparent');
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          !document.querySelector('button[title="匯出 SVG"]').disabled;
      `),
    'transparent theme render'
  );
  await setControlValue('檔名', 'input', 'transparent-background');
  const transparentSvgPath = await exportAndWait(
    '匯出 SVG',
    'transparent-background.svg'
  );
  const transparentPngPath = await exportAndWait(
    '匯出 PNG',
    'transparent-background.png'
  );
  const transparentSvg = await readFile(transparentSvgPath, 'utf8');
  assert.doesNotMatch(
    transparentSvg,
    /^<svg\b[^>]*><rect\b[^>]*fill="(?:#ffffff|#000000|transparent)"/i
  );
  const transparentPngMetadata = getPngMetadata(await readFile(transparentPngPath));
  assert.equal(transparentPngMetadata.firstPixelAlpha, 0);
  assert.ok(
    transparentPngMetadata.uniqueColorCount > 10,
    'Transparent PNG should still contain rendered diagram colors.'
  );
  await execute(`
    window.__originalSerializeSvg = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = function () {
      throw new Error('forced export failure');
    };
    document.querySelector('button[title="匯出 SVG"]').click();
  `);
  await waitFor(
    () =>
      execute(`
        const status = document.querySelector('.inline-status[role="alert"]');
        return status?.textContent.includes('匯出失敗') &&
          status.textContent.includes('forced export failure') &&
          !document.querySelector('button[title="匯出 SVG"]').disabled;
      `),
    'visible export failure recovery'
  );
  await execute(`
    XMLSerializer.prototype.serializeToString = window.__originalSerializeSvg;
    delete window.__originalSerializeSvg;
  `);

  await setControlValue('背景', 'select', 'black');
  assert.equal(
    await setEditorValue(
      '---\nconfig:\n  theme: default\n  themeCSS: "rect { fill: red !important; }"\n---\nflowchart TD\n  S[來源主題] --> T[仍應可讀]'
    ),
    true
  );
  await waitFor(
    () =>
      execute(`
        const svg = document.querySelector('.diagram-stage svg');
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          svg?.textContent.includes('來源主題') &&
          svg?.innerHTML.includes('fill:#ccc');
      `),
    'secure dark theme override'
  );

  assert.equal(await setEditorValue('flowchart TD\n  A[未關閉'), true);
  await waitFor(
    () => execute(`return document.querySelector('.status')?.textContent.trim() === 'Syntax error';`),
    'syntax error'
  );
  assert.equal(
    await execute(`
      return Boolean(document.querySelector('.error-box pre')?.textContent.trim()) &&
        !document.querySelector('.diagram-stage svg');
    `),
    true
  );
  assert.equal(
    await execute(`return document.querySelector('button[title="匯出 SVG"]').disabled;`),
    true
  );
  assert.equal(
    await execute(`
      return ['縮小預覽', '放大預覽', '以原始大小顯示 (100%)', '配合寬度', '適合預覽視窗 (Fit)']
        .every((title) => document.querySelector('button[title="' + title + '"]').disabled);
    `),
    true
  );

  await execute(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('修正錯誤'))
      .click();
  `);
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          document.querySelector('.diagram-stage svg')?.textContent.includes('Mock AI') &&
          !document.querySelector('button[title="匯出 SVG"]').disabled;
      `),
    'AI syntax recovery'
  );
  assert.equal(
    await execute(`return document.querySelector('button[title="放大預覽"]').disabled;`),
    false
  );
  const fixRequest = aiRequestBodies[aiRequestBodies.length - 1];
  const fixPayload = JSON.parse(
    fixRequest.messages.find((message) => message.role === 'user')?.content
  );
  assert.equal(fixPayload.mode, 'FIX_SYNTAX');
  assert.ok(fixPayload.parseError.trim().length > 0);
  assert.match(fixPayload.currentMermaid, /未關閉/);

  await execute(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('重設瀏覽器模型設定'))
      .click();
  `);
  await waitFor(
    () =>
      execute(`
        return localStorage.getItem('${'mermaid-flow-editor.api-config'}') === null &&
          sessionStorage.getItem('${'mermaid-flow-editor.api-key'}') === null;
      `),
    'settings clear'
  );
  assert.deepEqual(
    await execute(`
      const find = (labelText) => {
        const label = [...document.querySelectorAll('label')].find((item) =>
          item.textContent.trim().startsWith(labelText)
        );
        return label?.querySelector('input,select')?.value ?? null;
      };
      return {
        apiUrl: find('API URL'),
        apiKey: find('API Key'),
        model: find('Model'),
        status: document.querySelector('.connection-state')?.textContent.trim(),
        aiButtonsDisabled: [...document.querySelectorAll('.ai-actions button')].every(
          (button) => button.disabled
        )
      };
    `),
    {
      apiUrl: '',
      apiKey: '',
      model: '',
      status: '請輸入 API URL',
      aiButtonsDisabled: true
    }
  );

  const uploadElement = await webdriverRequest('POST', `${sessionRoute}/element`, {
    using: 'css selector',
    value: 'input[type="file"]'
  });
  await webdriverRequest(
    'POST',
    `${sessionRoute}/element/${uploadElement[elementKey]}/value`,
    { text: uploadFilePath }
  );
  await waitFor(
    () =>
      execute(`
        return document.querySelector('.status')?.textContent.trim() === 'Ready' &&
          document.querySelector('.diagram-stage svg')?.textContent.includes('Upload 測試');
      `),
    'Mermaid file upload'
  );

  const finalScreenshot = await webdriverRequest('GET', `${sessionRoute}/screenshot`);
  await writeFile(path.join(artifactDir, 'final.png'), Buffer.from(finalScreenshot, 'base64'));

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        appOrigin,
        mockOrigin,
        artifactDir,
        downloads: await readdir(downloadDir)
      },
      null,
      2
    )
  );
} catch (error) {
  if (geckodriver) {
    console.error(`Browser smoke test failed. Artifacts: ${artifactDir}`);
  }
  throw error;
} finally {
  if (sessionId) {
    await webdriverRequest('DELETE', `/session/${sessionId}`, undefined, 10_000).catch(() => {});
  }
  if (geckodriver && geckodriver.exitCode === null) {
    const exited = new Promise((resolve) => geckodriver.once('close', resolve));
    geckodriver.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
    if (!stopped && geckodriver.exitCode === null) {
      geckodriver.kill('SIGKILL');
      await Promise.race([exited, delay(2_000)]);
    }
  }
  appServer.closeAllConnections?.();
  mockServer.closeAllConnections?.();
  await close(appServer).catch(() => {});
  await close(mockServer).catch(() => {});
}
