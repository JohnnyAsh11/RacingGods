import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { OpenF1Service } from './openf1.service';
import { sampleSession, sampleSnapshot } from './testing.fixtures';
import { Snapshot } from './openf1.models';

describe('OpenF1Service', () => {
  let api: OpenF1Service;
  let http: HttpTestingController;
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(OpenF1Service);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('queries a specific season and sorts sessions newest first', () => {
    let keys: number[] = [];
    api.sessions(2023).subscribe((rows) => (keys = rows.map((row) => row.session_key)));
    http
      .expectOne('/api/openf1/sessions?year=2023')
      .flush([
        sampleSession,
        { ...sampleSession, session_key: 9999, date_start: '2023-10-01T12:00:00Z' },
      ]);
    expect(keys).toEqual([9999, 9165]);
  });

  it('treats only the documented no-results response as empty', () => {
    let count = -1;
    api.sessions(2023).subscribe((rows) => (count = rows.length));
    http
      .expectOne('/api/openf1/sessions?year=2023')
      .flush({ detail: 'No results found.' }, { status: 404, statusText: 'Not Found' });
    expect(count).toBe(0);
    let failed = false;
    api.sessions(2023).subscribe({ error: () => (failed = true) });
    http
      .expectOne('/api/openf1/sessions?year=2023')
      .flush({ detail: 'Unknown route' }, { status: 404, statusText: 'Not Found' });
    expect(failed).toBe(true);
  });

  it('paces sequential bounded requests and uses final classifications', async () => {
    let result: Snapshot | undefined;
    api.snapshot(sampleSession).subscribe((data) => (result = data));
    http.expectNone((r) => r.url.includes('drivers'));
    await vi.advanceTimersByTimeAsync(1100);
    http.expectOne((r) => r.url.endsWith('/drivers')).flush(sampleSnapshot.drivers);
    await vi.advanceTimersByTimeAsync(1100);
    http
      .expectOne((r) => r.url.endsWith('/session_result'))
      .flush([{ driver_number: 55, position: 1 }]);
    await vi.advanceTimersByTimeAsync(1100);
    const laps = http.expectOne((r) => r.url.endsWith('/laps'));
    expect(laps.request.params.get('date_start>')).toBe('2023-09-17T13:30:00.000Z');
    expect(laps.request.params.get('date_start<')).toBe('2023-09-17T14:00:00.000Z');
    laps.flush([]);
    await vi.advanceTimersByTimeAsync(1100);
    http.expectOne((r) => r.url.endsWith('/weather')).flush([]);
    await vi.advanceTimersByTimeAsync(1100);
    http.expectOne((r) => r.url.endsWith('/race_control')).flush([]);
    expect(result?.drivers.length).toBe(1);
    expect(result?.warnings).toEqual([]);
    http.expectNone((r) => r.url.endsWith('/position') || r.url.endsWith('/intervals'));
  });

  it('cancels pending work when unsubscribed', async () => {
    const subscription = api.snapshot(sampleSession).subscribe();
    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(60000);
    http.expectNone((r) => r.url.includes('/api/openf1'));
  });

  it('uses only a five-minute window for active practice and skips race intervals', async () => {
    vi.setSystemTime(new Date('2023-09-17T13:00:00Z'));
    const subscription = api
      .snapshot({ ...sampleSession, session_type: 'Practice' }, sampleSnapshot)
      .subscribe();
    await vi.advanceTimersByTimeAsync(1100);
    const positions = http.expectOne((r) => r.url.endsWith('/position'));
    expect(positions.request.params.get('date>')).toBe('2023-09-17T12:55:00.000Z');
    expect(positions.request.params.get('date<')).toBe('2023-09-17T13:00:00.000Z');
    positions.flush([]);
    await vi.advanceTimersByTimeAsync(1100);
    const laps = http.expectOne((r) => r.url.endsWith('/laps'));
    http.expectNone((r) => r.url.endsWith('/intervals') || r.url.endsWith('/session_result'));
    laps.flush([]);
    subscription.unsubscribe();
  });

  it('stops immediately on rate limiting rather than sending the other endpoints', async () => {
    let status = 0;
    api.snapshot(sampleSession).subscribe({ error: (error) => (status = error.status) });
    await vi.advanceTimersByTimeAsync(1100);
    http
      .expectOne((r) => r.url.endsWith('/drivers'))
      .flush({}, { status: 429, statusText: 'Too Many Requests' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(status).toBe(429);
    http.expectNone((r) => r.url.includes('/api/openf1'));
  });

  it('surfaces partial errors while keeping independent panels available', async () => {
    let result: Snapshot | undefined;
    api.snapshot(sampleSession, sampleSnapshot).subscribe((data) => (result = data));
    await vi.advanceTimersByTimeAsync(1100);
    http
      .expectOne((r) => r.url.endsWith('/session_result'))
      .flush([{ driver_number: 55, position: 1 }]);
    await vi.advanceTimersByTimeAsync(1100);
    http.expectOne((r) => r.url.endsWith('/laps')).flush([]);
    await vi.advanceTimersByTimeAsync(1100);
    http
      .expectOne((r) => r.url.endsWith('/weather'))
      .flush({}, { status: 503, statusText: 'Unavailable' });
    await vi.advanceTimersByTimeAsync(1100);
    http.expectOne((r) => r.url.endsWith('/race_control')).flush([]);
    expect(result?.warnings[0]).toContain('weather: OpenF1 request failed (HTTP 503)');
  });
});
