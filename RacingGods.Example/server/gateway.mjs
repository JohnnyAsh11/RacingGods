import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'https://api.openf1.org/v1/';
const HOSTS = new Set(['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:4200', 'localhost:4200']);
const ORIGINS = new Set([...HOSTS].map((host) => `http://${host}`));
const WINDOWS = { position: 'date', intervals: 'date', laps: 'date_start', weather: 'date', race_control: 'date' };
const ENDPOINTS = new Set(['sessions', 'drivers', 'session_result', ...Object.keys(WINDOWS)]);
const MAX_BODY = 4 * 1024 * 1024;

class GatewayError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function validateQuery(endpoint, params, year = new Date().getUTCFullYear()) {
  if (!ENDPOINTS.has(endpoint)) throw new GatewayError(404, 'Unknown API endpoint.');
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new GatewayError(400, 'Duplicate filters are not allowed.');
  if (endpoint === 'sessions') {
    if (keys.length === 1 && (
      (keys[0] === 'year' && /^\d{4}$/.test(params.get('year')) && +params.get('year') >= 2023 && +params.get('year') <= year + 1) ||
      (keys[0] === 'session_key' && params.get('session_key') === 'latest')
    )) return;
    throw new GatewayError(400, 'Select a supported year or the latest session.');
  }
  if (!/^[1-9]\d{0,9}$/.test(params.get('session_key') ?? '')) {
    throw new GatewayError(400, 'A numeric session_key is required.');
  }
  const date = WINDOWS[endpoint];
  const allowed = date ? ['session_key', `${date}>`, `${date}<`] : ['session_key'];
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new GatewayError(400, 'Unsupported or missing filters.');
  }
  if (date) {
    const bounds = ['>', '<'].map((operator) => params.get(`${date}${operator}`));
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
    const [start, end] = bounds.map((value) => {
      const parsed = iso.test(value) ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
    });
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 30 * 60_000) {
      throw new GatewayError(400, 'A UTC time window of at most 30 minutes is required.');
    }
  }
}

export function retryAfterSeconds(value, now = Date.now()) {
  if (value && /^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) return Math.max(1, seconds);
  }
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? Math.max(1, Math.ceil((timestamp - now) / 1000)) : 30;
}

export class OutboundQueue {
  constructor({ spacingMs = 2100, maxQueue = 16, queueTimeoutMs = 12_000 } = {}) {
    this.spacingMs = spacingMs;
    this.maxQueue = maxQueue;
    this.queueTimeoutMs = queueTimeoutMs;
    this.queue = [];
    this.lastStart = -Infinity;
    this.cooldownUntil = 0;
    this.running = false;
    this.closed = false;
    this.stop = new AbortController();
  }

  cooldown(seconds) {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + seconds * 1000);
  }

  cooldownError() {
    return new GatewayError(429, 'OpenF1 rate limit reached. Retry later.', Math.max(1, Math.ceil((this.cooldownUntil - Date.now()) / 1000)));
  }

  run(task, signal) {
    if (this.closed) return Promise.reject(new GatewayError(503, 'Gateway is shutting down.'));
    if (Date.now() < this.cooldownUntil) return Promise.reject(this.cooldownError());
    if (this.queue.filter((job) => !job.done).length >= this.maxQueue) {
      return Promise.reject(new GatewayError(503, 'Gateway is busy. Retry later.'));
    }
    return new Promise((resolve, reject) => {
      const job = { task, signal, done: false };
      const finish = (error, result) => {
        if (job.done) return;
        job.done = true;
        clearTimeout(job.timer);
        const index = this.queue.indexOf(job);
        if (index !== -1) this.queue.splice(index, 1);
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(result);
      };
      const cancel = () => finish(new GatewayError(499, 'Request cancelled.'));
      job.finish = finish;
      job.timer = setTimeout(() => finish(new GatewayError(503, 'Gateway queue timed out. Retry later.')), this.queueTimeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      if (job.done) return;
      this.queue.push(job);
      void this.pump();
    });
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const job = this.queue.shift();
        if (job.done) continue;
        if (Date.now() < this.cooldownUntil) {
          job.finish(this.cooldownError());
          continue;
        }
        while (!job.done && !this.closed && performance.now() < this.lastStart + this.spacingMs) {
          const delay = Math.max(1, this.lastStart + this.spacingMs - performance.now());
          await new Promise((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              this.stop.signal.removeEventListener('abort', finish);
              resolve();
            };
            const timer = setTimeout(finish, delay);
            this.stop.signal.addEventListener('abort', finish, { once: true });
          });
        }
        if (job.done) continue;
        if (this.closed) {
          job.finish(new GatewayError(503, 'Gateway is shutting down.'));
          continue;
        }
        if (Date.now() < this.cooldownUntil) {
          job.finish(this.cooldownError());
          continue;
        }
        clearTimeout(job.timer);
        this.lastStart = performance.now();
        try {
          job.finish(null, await job.task());
        } catch (error) {
          job.finish(error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  close() {
    this.closed = true;
    this.stop.abort();
    for (const job of this.queue.splice(0)) job.finish(new GatewayError(503, 'Gateway is shutting down.'));
  }
}

function json(res, status, body, retryAfter) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
  });
  res.end(JSON.stringify(body));
}

async function readJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BODY) {
    await response.body?.cancel();
    throw new GatewayError(502, 'OpenF1 response is too large.');
  }
  const chunks = [];
  let size = 0;
  if (!response.body) throw new GatewayError(502, 'Invalid OpenF1 response.');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BODY) throw new GatewayError(502, 'OpenF1 response is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GatewayError(502, 'Invalid OpenF1 response.');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

async function serveStatic(res, pathname, root) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new GatewayError(400, 'Invalid path.'); }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes(':') ||
      decoded.split('/').some((part) => part.startsWith('.'))) {
    throw new GatewayError(400, 'Invalid path.');
  }
  const base = await realpath(root).catch(() => null);
  if (!base) throw new GatewayError(503, 'Build the dashboard with npm run build first.');
  let filename = path.resolve(base, `.${decoded}`);
  let info = await stat(filename).catch(() => null);
  if (!info?.isFile()) {
    if (path.extname(decoded)) throw new GatewayError(404, 'File not found.');
    filename = path.join(base, 'index.html');
  }
  const resolved = await realpath(filename).catch(() => null);
  const relative = resolved ? path.relative(base, resolved) : '..';
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new GatewayError(404, 'File not found.');
  const body = await readFile(resolved);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}

export function createGateway({
  token = process.env.OPENF1_ACCESS_TOKEN?.trim() ?? '',
  fetchImpl = globalThis.fetch,
  staticRoot = path.join(ROOT, 'dist', 'openf1-dashboard', 'browser'),
  queue = new OutboundQueue(),
} = {}) {
  const cache = new Map();
  let cacheBytes = 0;
  const shutdown = new AbortController();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const disconnected = new AbortController();
    res.on('close', () => disconnected.abort());
    try {
      if (!HOSTS.has(req.headers.host) || (req.headers.origin && !ORIGINS.has(req.headers.origin))) {
        throw new GatewayError(403, 'Unexpected request host or origin.');
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new GatewayError(405, 'Only GET is supported.');
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048 || req.url.includes('\\')) {
        throw new GatewayError(400, 'Invalid request path.');
      }
      // Check before URL normalization, which otherwise removes dot segments.
      const rawPath = req.url.split('?')[0];
      let decodedPath;
      try { decodedPath = decodeURIComponent(rawPath); } catch { throw new GatewayError(400, 'Invalid request path.'); }
      if (decodedPath.split('/').some((part) => part === '.' || part === '..') || decodedPath.includes('\\')) {
        throw new GatewayError(400, 'Invalid request path.');
      }
      const url = new URL(req.url, 'http://127.0.0.1:8787');
      if (url.pathname === '/api/config') {
        if (url.search) throw new GatewayError(400, 'Unsupported filters.');
        json(res, 200, { liveEnabled: Boolean(token) });
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        await serveStatic(res, url.pathname, staticRoot);
        return;
      }
      const match = /^\/api\/openf1\/([a-z_]+)$/.exec(url.pathname);
      if (!match) throw new GatewayError(404, 'Unknown API endpoint.');
      const endpoint = match[1];
      validateQuery(endpoint, url.searchParams);
      url.searchParams.sort();
      const cacheKey = `${endpoint}?${url.searchParams}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        json(res, 200, cached.data);
        return;
      }
      const data = await queue.run(async () => {
        const signal = AbortSignal.any([AbortSignal.timeout(10_000), disconnected.signal, shutdown.signal]);
        try {
          const upstream = await fetchImpl(`${UPSTREAM}${cacheKey}`, {
            method: 'GET',
            headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            redirect: 'manual',
            signal,
          });
          if (upstream.status === 429) {
            const seconds = retryAfterSeconds(upstream.headers.get('retry-after'));
            queue.cooldown(seconds);
            await upstream.body?.cancel().catch(() => {});
            throw new GatewayError(429, 'OpenF1 rate limit reached. Retry later.', seconds);
          }
          if (upstream.status === 401 || upstream.status === 403) {
            await upstream.body?.cancel().catch(() => {});
            throw new GatewayError(upstream.status, 'OpenF1 authentication or access failed.');
          }
          if (upstream.status === 404) {
            const body = await readJson(upstream);
            if (body?.detail === 'No results found.') return { noResults: true };
            throw new GatewayError(404, 'OpenF1 resource not found.');
          }
          if (upstream.status !== 200) {
            await upstream.body?.cancel().catch(() => {});
            throw new GatewayError(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, 'OpenF1 request failed.');
          }
          const body = await readJson(upstream);
          if (!Array.isArray(body)) throw new GatewayError(502, 'Invalid OpenF1 response.');
          return body;
        } catch (error) {
          if (error instanceof GatewayError) throw error;
          throw new GatewayError(signal.aborted ? 504 : 502, signal.aborted ? 'OpenF1 request timed out or was cancelled.' : 'Cannot reach OpenF1.');
        }
      }, disconnected.signal);
      if (data.noResults) {
        json(res, 404, { detail: 'No results found.' });
        return;
      }
      const cacheable = !token && (endpoint === 'drivers' ||
        (endpoint === 'sessions' && Number(url.searchParams.get('year')) < new Date().getUTCFullYear() && url.searchParams.has('year')));
      if (cacheable) {
        const bytes = Buffer.byteLength(JSON.stringify(data));
        if (bytes <= 512 * 1024) {
          if (cache.has(cacheKey)) { cacheBytes -= cache.get(cacheKey).bytes; cache.delete(cacheKey); }
          while (cache.size >= 32 || cacheBytes + bytes > 2 * 1024 * 1024) {
            const key = cache.keys().next().value;
            cacheBytes -= cache.get(key).bytes;
            cache.delete(key);
          }
          cache.set(cacheKey, { data, bytes, expires: Date.now() + 60_000 });
          cacheBytes += bytes;
        }
      }
      if (!res.destroyed) json(res, 200, data);
    } catch (error) {
      if (res.destroyed) return;
      const safe = error instanceof GatewayError ? error : new GatewayError(500, 'Gateway request failed.');
      json(res, safe.status, { error: safe.message }, safe.retryAfter);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.shutdown = () => {
    shutdown.abort();
    queue.close();
    server.close();
    server.closeAllConnections();
  };
  return server;
}
