import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenAiEndpoint, createApp } from './index.js';

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no TCP address.');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`
  };
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('health endpoint is available without authentication', async () => {
  const { server, origin } = await listen(createApp({ serveStatic: false }));
  try {
    const response = await fetch(`${origin}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await close(server);
  }
});

test('buildOpenAiEndpoint normalizes OpenAI-compatible paths and preserves queries', () => {
  assert.equal(
    buildOpenAiEndpoint('http://10.0.0.8:8000/v1/', 'models').href,
    'http://10.0.0.8:8000/v1/models'
  );
  assert.equal(
    buildOpenAiEndpoint(
      'https://ai.internal/v1/chat/completions/?api-version=2026-01-01#fragment',
      'chat/completions'
    ).href,
    'https://ai.internal/v1/chat/completions?api-version=2026-01-01'
  );
});

test('buildOpenAiEndpoint rejects unsafe schemes, embedded credentials, and disallowed hosts', () => {
  assert.throws(() => buildOpenAiEndpoint('file:///etc/passwd', 'models'), /HTTP/);
  assert.throws(
    () => buildOpenAiEndpoint('http://user:pass@ai.internal/v1', 'models'),
    /credentials/
  );
  assert.throws(
    () => buildOpenAiEndpoint('http://other.internal/v1', 'models', ['ai.internal']),
    /not allowed/
  );
});

test('models proxy forwards authorization and upstream JSON', async () => {
  let captured;
  const app = createApp({
    serveStatic: false,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), authorization: init.headers.Authorization };
      return new Response(JSON.stringify({ data: [{ id: 'mock-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const { server, origin } = await listen(app);

  try {
    const response = await fetch(`${origin}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiUrl: 'http://ai.internal/v1',
        apiKey: 'secret'
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: 'mock-model' }] });
    assert.deepEqual(captured, {
      url: 'http://ai.internal/v1/models',
      authorization: 'Bearer secret'
    });
  } finally {
    await close(server);
  }
});

test('chat proxy preserves useful non-JSON upstream errors', async () => {
  const app = createApp({
    serveStatic: false,
    fetchImpl: async () =>
      new Response('bad token', {
        status: 401,
        headers: { 'content-type': 'text/plain' }
      })
  });
  const { server, origin } = await listen(app);

  try {
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiUrl: 'http://ai.internal/v1',
        apiKey: 'secret',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'ping' }]
      })
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type') || '', /^text\/plain/);
    assert.equal(await response.text(), 'bad token');
  } finally {
    await close(server);
  }
});

test('upstream timeouts before headers return 504 and release the request', async () => {
  const app = createApp({
    serveStatic: false,
    modelsTimeoutMs: 25,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      })
  });
  const { server, origin } = await listen(app);

  try {
    const response = await fetch(`${origin}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiUrl: 'http://ai.internal/v1',
        apiKey: 'secret'
      })
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'Upstream API request timed out.' });
  } finally {
    await close(server);
  }
});

test('upstream timeouts also cover a response body that never finishes', async () => {
  const app = createApp({
    serveStatic: false,
    modelsTimeoutMs: 25,
    fetchImpl: async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['));
            init.signal.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          }
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
  });
  const { server, origin } = await listen(app);

  try {
    const response = await fetch(`${origin}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiUrl: 'http://ai.internal/v1',
        apiKey: 'secret'
      })
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'Upstream API request timed out.' });
  } finally {
    await close(server);
  }
});

test('host allowlist blocks upstream redirects from being followed', async () => {
  let redirectMode;
  const app = createApp({
    serveStatic: false,
    allowedHosts: ['ai.internal'],
    fetchImpl: async (_url, init) => {
      redirectMode = init.redirect;
      return new Response('', {
        status: 302,
        headers: { location: 'http://other.internal/models' }
      });
    }
  });
  const { server, origin } = await listen(app);

  try {
    const response = await fetch(`${origin}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiUrl: 'http://ai.internal/v1',
        apiKey: 'secret'
      })
    });
    assert.equal(redirectMode, 'manual');
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /redirects are not allowed/);
  } finally {
    await close(server);
  }
});

test('BYOK requests require both an API URL and API key', async () => {
  let fetchCalled = false;
  const app = createApp({
    serveStatic: false,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('must not run');
    }
  });
  const { server, origin } = await listen(app);

  try {
    for (const [body, message] of [
      [{ apiUrl: '', apiKey: 'secret' }, 'apiUrl is required.'],
      [{ apiUrl: 'https://models.example.test/v1', apiKey: '' }, 'apiKey is required.']
    ]) {
      const response = await fetch(`${origin}/api/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: message });
    }
    assert.equal(fetchCalled, false);
  } finally {
    await close(server);
  }
});

test('chat validation rejects empty messages before contacting upstream', async () => {
  let fetchCalled = false;
  const app = createApp({
    serveStatic: false,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('must not run');
    }
  });
  const { server, origin } = await listen(app);

  try {
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiUrl: 'http://ai.internal/v1',
        apiKey: 'secret',
        model: 'mock-model',
        messages: []
      })
    });
    assert.equal(response.status, 400);
    assert.equal(fetchCalled, false);
  } finally {
    await close(server);
  }
});

test('JSON parser returns safe 400 and 413 responses', async () => {
  const app = createApp({
    serveStatic: false,
    jsonBodyLimit: '32b'
  });
  const { server, origin } = await listen(app);

  try {
    const malformed = await fetch(`${origin}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json'
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: '請求格式無效。' });

    const oversized = await fetch(`${origin}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(64) })
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: '請求內容過大。' });
  } finally {
    await close(server);
  }
});
