import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiPolicyError, validateCustomMessages } from './mermaid-ai-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MODELS_TIMEOUT_MS = 15_000;
const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

class UpstreamTimeoutError extends Error {}
class ClientDisconnectedError extends Error {}

function parseTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedHosts(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function resolveUpstreamCredentials(body) {
  const apiUrl = typeof body?.apiUrl === 'string' ? body.apiUrl.trim() : '';
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiUrl) throw new TypeError('apiUrl is required.');
  if (!apiKey) throw new TypeError('apiKey is required.');
  return { apiUrl, apiKey };
}

export function buildOpenAiEndpoint(apiUrl, suffix, allowedHosts = []) {
  if (typeof apiUrl !== 'string' || !apiUrl.trim() || apiUrl.length > 2_048) {
    throw new TypeError('API URL is not valid.');
  }

  const endpoint = new URL(apiUrl.trim());
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new TypeError('Only HTTP(S) API URLs are supported.');
  }
  if (endpoint.username || endpoint.password) {
    throw new TypeError('API URL must not contain embedded credentials.');
  }
  if (allowedHosts.length && !allowedHosts.includes(endpoint.host.toLowerCase())) {
    throw new TypeError('API host is not allowed.');
  }

  endpoint.hash = '';
  endpoint.pathname = endpoint.pathname
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '');
  endpoint.pathname = path.posix.join(endpoint.pathname, suffix);
  return endpoint;
}

async function fetchUpstream(req, res, fetchImpl, endpoint, init, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let clientDisconnected = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortForDisconnect = () => {
    clientDisconnected = true;
    controller.abort();
  };

  req.once('aborted', abortForDisconnect);
  res.once('close', abortForDisconnect);

  try {
    const upstream = await fetchImpl(endpoint, { ...init, signal: controller.signal });
    if (init.redirect === 'manual' && upstream.status >= 300 && upstream.status < 400) {
      throw new Error('Upstream redirects are not allowed when AI_API_ALLOWED_HOSTS is set.');
    }
    const text = await upstream.text();
    return {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') || 'application/json',
      text
    };
  } catch (error) {
    if (timedOut) throw new UpstreamTimeoutError('Upstream API request timed out.');
    if (clientDisconnected) throw new ClientDisconnectedError('Client disconnected.');
    throw error;
  } finally {
    clearTimeout(timeoutId);
    req.off('aborted', abortForDisconnect);
    res.off('close', abortForDisconnect);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

export function createApp(options = {}) {
  const app = express();
  const fetchImpl = options.fetchImpl || fetch;
  const modelsTimeoutMs = parseTimeout(
    options.modelsTimeoutMs ?? process.env.MODELS_TIMEOUT_MS,
    DEFAULT_MODELS_TIMEOUT_MS
  );
  const chatTimeoutMs = parseTimeout(
    options.chatTimeoutMs ?? process.env.CHAT_TIMEOUT_MS,
    DEFAULT_CHAT_TIMEOUT_MS
  );
  const allowedHosts =
    options.allowedHosts || parseAllowedHosts(process.env.AI_API_ALLOWED_HOSTS);

  app.disable('x-powered-by');
  app.use(express.json({ limit: options.jsonBodyLimit || process.env.JSON_BODY_LIMIT || '256kb' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/api/models', async (req, res) => {
    let credentials;
    try {
      credentials = resolveUpstreamCredentials(req.body);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'AI connection is not configured.'
      });
    }

    let endpoint;
    try {
      endpoint = buildOpenAiEndpoint(credentials.apiUrl, 'models', allowedHosts);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'API URL is not valid.'
      });
    }

    try {
      const upstream = await fetchUpstream(
        req,
        res,
        fetchImpl,
        endpoint,
        {
          redirect: allowedHosts.length ? 'manual' : 'follow',
          headers: {
            Authorization: 'Bearer ' + credentials.apiKey,
            Accept: 'application/json'
          }
        },
        modelsTimeoutMs
      );

      return res.status(upstream.status).type(upstream.contentType).send(upstream.text);
    } catch (error) {
      if (error instanceof ClientDisconnectedError || res.destroyed) return;
      if (error instanceof UpstreamTimeoutError) {
        return res.status(504).json({ error: error.message });
      }
      return res.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to fetch models.'
      });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const { model, messages, temperature } = req.body || {};

    if (!isNonEmptyString(model)) {
      return res.status(400).json({ error: 'model is required.' });
    }

    let credentials;
    try {
      credentials = resolveUpstreamCredentials(req.body);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'AI connection is not configured.'
      });
    }

    let endpoint;
    try {
      endpoint = buildOpenAiEndpoint(credentials.apiUrl, 'chat/completions', allowedHosts);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'API URL is not valid.'
      });
    }

    let upstreamMessages;
    try {
      upstreamMessages = validateCustomMessages(messages);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof AiPolicyError ? error.message : 'messages are not valid.'
      });
    }

    try {
      const upstreamBody = { model: model.trim(), messages: upstreamMessages };
      if (
        typeof temperature === 'number' &&
        Number.isFinite(temperature) &&
        temperature >= 0 &&
        temperature <= 2
      ) {
        upstreamBody.temperature = temperature;
      }

      const upstream = await fetchUpstream(
        req,
        res,
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          redirect: allowedHosts.length ? 'manual' : 'follow',
          headers: {
            Authorization: 'Bearer ' + credentials.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(upstreamBody)
        },
        chatTimeoutMs
      );

      return res.status(upstream.status).type(upstream.contentType).send(upstream.text);
    } catch (error) {
      if (error instanceof ClientDisconnectedError || res.destroyed) return;
      if (error instanceof UpstreamTimeoutError) {
        return res.status(504).json({ error: error.message });
      }
      return res.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to call API.'
      });
    }
  });

  if (options.serveStatic !== false) {
    const distDir = path.join(__dirname, '..', 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status =
      Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
        ? error.status
        : 500;
    if (status >= 500) {
      console.error('Request failed:', error instanceof Error ? error.message : error);
    }
    const message =
      status === 413
        ? '請求內容過大。'
        : status < 500
          ? '請求格式無效。'
          : '伺服器處理請求時發生錯誤。';
    return res.status(status).json({ error: message });
  });

  return app;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  const port = Number(process.env.PORT || process.env.APP_API_PORT || 3001);
  const app = createApp();
  app.listen(port, '0.0.0.0', () => {
    console.log('Mermaid editor listening on http://0.0.0.0:' + port);
  });
}
