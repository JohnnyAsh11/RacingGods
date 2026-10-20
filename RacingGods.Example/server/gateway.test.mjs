import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGateway, OutboundQueue, retryAfterSeconds, validateQuery } from './gateway.mjs';

const servers = [];
const queues = [];
const directories = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  for (const server of servers.splice(0)) {
    const closed = once(server, 'close');
    server.shutdown();
    await closed;
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

async function gateway(options = {}) {
  const server = createGateway({ token: '', ...options });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (url, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: url,
      method: options.method ?? 'GET', headers: { Host: '127.0.0.1:8787', ...options.headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ok = (body = []) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const timeQuery = (field = 'date', start = '2023-09-17T12:00:00Z', end = '2023-09-17T12:30:00Z') =>
  new URLSearchParams({ session_key: '9165', [`${field}>`]: start, [`${field}<`]: end });

describe('filter validation', () => {
  it('allows only supported session lookups', () => {
    for (const query of ['year=2023', 'year=2027', 'session_key=latest']) {
      expect(() => validateQuery('sessions', new URLSearchParams(query), 2026)).not.toThrow();
    }
    for (const query of ['', 'year=2022', 'year=2028', 'year=2023&year=2024', 'session_key=9165', 'year=2023&url=https://example.com']) {
      expect(() => validateQuery('sessions', new URLSearchParams(query), 2026)).toThrow();
    }
  });
  it('requires numeric sessions and bounded timestamp filters on every time series', () => {
    for (const endpoint of ['position', 'intervals', 'weather', 'race_control', 'laps']) {
      const field = endpoint === 'laps' ? 'date_start' : 'date';
      expect(() => validateQuery(endpoint, timeQuery(field))).not.toThrow();
      expect(() => validateQuery(endpoint, new URLSearchParams('session_key=latest'))).toThrow();
      expect(() => validateQuery(endpoint, timeQuery(field, '2023-09-17T12:00:00Z', '2023-09-17T12:30:01Z'))).toThrow();
      expect(() => validateQuery(endpoint, timeQuery(field, '2023-09-17T12:00:00Z', '2023-09-17T11:30:00Z'))).toThrow();
      expect(() => validateQuery(endpoint, timeQuery(field, '2023-02-30T12:00:00Z', '2023-03-02T12:00:00Z'))).toThrow();
    }
    for (const endpoint of ['drivers', 'session_result']) {
      expect(() => validateQuery(endpoint, new URLSearchParams('session_key=9165'))).not.toThrow();
      expect(() => validateQuery(endpoint, new URLSearchParams('session_key=9165&driver_number=1'))).toThrow();
    }
    expect(() => validateQuery('car_data', timeQuery())).toThrow();
  });
});

describe('gateway HTTP behavior', () => {
  it('reports credential presence without exposing it or claiming validity', async () => {
    const fetchImpl = vi.fn();
    const request = await gateway({ token: 'private-test-value', fetchImpl });
    expect(JSON.parse((await request('/api/config')).text)).toEqual({ liveEnabled: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    const publicRequest = await gateway();
    expect(JSON.parse((await publicRequest('/api/config')).text)).toEqual({ liveEnabled: false });
  });
  it('rejects unexpected hosts, origins, methods, endpoints, duplicate and arbitrary filters', async () => {
    const fetchImpl = vi.fn();
    const request = await gateway({ fetchImpl });
    expect((await request('/api/config', { headers: { Host: 'evil.example:8787' } })).status).toBe(403);
    expect((await request('/api/config', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request('/api/config', { method: 'POST' })).status).toBe(405);
    for (const url of ['/api/openf1/car_data?session_key=9165', '/api/openf1/drivers?session_key=9165&url=x', '/api/openf1/drivers?session_key=1&session_key=2', '/api/openf1/position?session_key=9165', '/api/openf1/%2e%2e/config', '/%ZZ']) {
      expect((await request(url)).status).toBeGreaterThanOrEqual(400);
    }
    for (const origin of ['http://localhost:4200', 'http://127.0.0.1:4200', 'http://localhost:8787', 'http://127.0.0.1:8787']) {
      expect((await request('/api/config', { headers: { Origin: origin } })).status).toBe(200);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('forwards only a fixed HTTPS path and caches successful public metadata', async () => {
    const fetchImpl = vi.fn(async () => ok([{ driver_number: 1 }]));
    const request = await gateway({ fetchImpl });
    expect((await request('/api/openf1/drivers?session_key=9165')).status).toBe(200);
    expect((await request('/api/openf1/drivers?session_key=9165')).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openf1.org/v1/drivers?session_key=9165');
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.redirect).toBe('manual');
  });
  it.each([401, 403])('preserves upstream %s without leaking errors or falling back', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('private-test-value upstream secret', { status }));
    const request = await gateway({ fetchImpl, token: 'private-test-value' });
    const result = await request('/api/openf1/drivers?session_key=9165');
    expect(result.status).toBe(status);
    expect(result.text).not.toContain('private-test-value');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer private-test-value');
  });
  it('does not cache authenticated responses', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const request = await gateway({ fetchImpl, token: 'token' });
    await request('/api/openf1/drivers?session_key=9165');
    await request('/api/openf1/drivers?session_key=9165');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('enforces an upstream 429 cooldown across endpoints', async () => {
    const fetchImpl = vi.fn(async () => new Response('sensitive upstream error', { status: 429, headers: { 'Retry-After': '120' } }));
    const request = await gateway({ fetchImpl });
    const first = await request('/api/openf1/drivers?session_key=9165');
    const next = await request('/api/openf1/sessions?year=2023');
    expect(first.status).toBe(429);
    expect(next.status).toBe(429);
    expect(Number(next.headers['retry-after'])).toBeGreaterThanOrEqual(119);
    expect(next.text).not.toContain('sensitive');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('preserves the documented no-results 404, but never invents a successful empty array', async () => {
    const request = await gateway({ fetchImpl: async () => new Response('{"detail":"No results found."}', { status: 404 }) });
    const result = await request('/api/openf1/session_result?session_key=9165');
    expect(result.status).toBe(404);
    expect(JSON.parse(result.text)).toEqual({ detail: 'No results found.' });
  });
  it.each([
    () => ok({ detail: 'not an array' }),
    () => new Response('not json'),
    () => new Response('secret', { status: 302, headers: { Location: 'https://evil.example' } }),
    () => new Response('[]', { headers: { 'Content-Length': String(5 * 1024 * 1024) } }),
    () => { throw new Error('Bearer private-test-value'); },
  ])('sanitizes invalid, oversized, redirected and failed upstream responses', async (response) => {
    const request = await gateway({ token: 'private-test-value', fetchImpl: async () => response() });
    const result = await request('/api/openf1/drivers?session_key=9165');
    expect(result.status).toBe(502);
    expect(result.text).not.toContain('private-test-value');
  });
  it('times out a stalled upstream request without leaking credentials', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const request = await gateway({ token: 'private-test-value', fetchImpl });
    const result = await request('/api/openf1/drivers?session_key=9165');
    expect(result.status).toBe(504);
    expect(result.text).not.toContain('private-test-value');
  }, 15_000);
  it('serves built files and SPA routes without exposing files outside the public root', async () => {
    const directory = path.resolve('server', `.test-static-${crypto.randomUUID()}`);
    directories.push(directory);
    await mkdir(directory);
    await writeFile(path.join(directory, 'index.html'), '<h1>Dashboard</h1>');
    await writeFile(path.join(directory, 'main.js'), 'console.log("dashboard")');
    const request = await gateway({ staticRoot: directory });
    expect((await request('/')).text).toBe('<h1>Dashboard</h1>');
    expect((await request('/dashboard')).status).toBe(200);
    expect((await request('/main.js')).headers['content-type']).toContain('javascript');
    expect((await request('/missing.js')).status).toBe(404);
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/%5c..%5cpackage.json', '/.env', '/C:%5cWindows']) {
      expect((await request(url)).status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('global outbound queue', () => {
  it('spaces outbound starts by at least 2100ms even with concurrent callers', async () => {
    const queue = new OutboundQueue();
    queues.push(queue);
    const starts = [];
    await Promise.all([1, 2, 3].map(() => queue.run(async () => starts.push(performance.now()))));
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(2100);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(2100);
  }, 7000);
  it('bounds the queue and expires requests before they can go upstream', async () => {
    const queue = new OutboundQueue({ maxQueue: 1, queueTimeoutMs: 20 });
    queues.push(queue);
    let release;
    const first = queue.run(() => new Promise((resolve) => { release = resolve; }));
    const task = vi.fn();
    const second = queue.run(task);
    const expired = expect(second).rejects.toMatchObject({ status: 503 });
    await expect(queue.run(task)).rejects.toMatchObject({ status: 503 });
    await expired;
    release([]);
    await first;
    expect(task).not.toHaveBeenCalled();
  });
  it('removes disconnected queued clients', async () => {
    const queue = new OutboundQueue();
    queues.push(queue);
    let release;
    const first = queue.run(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const task = vi.fn();
    const pending = queue.run(task, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ status: 499 });
    controller.abort();
    await cancelled;
    expect(queue.queue).toHaveLength(0);
    release([]);
    await first;
    expect(task).not.toHaveBeenCalled();
  });
  it('rejects already queued work on shared cooldown without sending it', async () => {
    const queue = new OutboundQueue();
    queues.push(queue);
    let release;
    const first = queue.run(() => new Promise((resolve) => { release = resolve; }));
    const task = vi.fn();
    const second = queue.run(task);
    const limited = expect(second).rejects.toMatchObject({ status: 429, retryAfter: 60 });
    queue.cooldown(60);
    release([]);
    await first;
    await limited;
    expect(task).not.toHaveBeenCalled();
  });
  it('parses delta seconds and HTTP dates conservatively', () => {
    expect(retryAfterSeconds('45', 0)).toBe(45);
    expect(retryAfterSeconds('Thu, 01 Jan 1970 00:01:00 GMT', 0)).toBe(60);
    expect(retryAfterSeconds('invalid', 0)).toBe(30);
    expect(retryAfterSeconds(null, 0)).toBe(30);
  });
});
