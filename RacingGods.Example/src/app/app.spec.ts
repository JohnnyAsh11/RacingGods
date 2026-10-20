import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { App } from './app';
import { OpenF1Service } from './openf1.service';
import { sampleSession, sampleSnapshot } from './testing.fixtures';
import { Snapshot } from './openf1.models';

describe('Pit wall dashboard', () => {
  const service = {
    config: vi.fn(),
    latest: vi.fn(),
    sessions: vi.fn(),
    snapshot: vi.fn(),
  };
  beforeEach(() => {
    service.config.mockReturnValue(of({ liveEnabled: false }));
    service.latest.mockReturnValue(of([sampleSession]));
    service.sessions.mockReturnValue(of([sampleSession]));
    service.snapshot.mockReturnValue(of(sampleSnapshot));
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: OpenF1Service, useValue: service }],
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders real retrieved data and labels it recorded, never live', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('h1')?.textContent).toContain('Your seat on the pit wall');
    expect(page.textContent).toContain('Carlos SAINZ');
    expect(page.textContent).toContain('RECORDED');
    expect(fixture.componentInstance.live()).toBe(false);
  });

  it('shows a clear empty state for seasons with no sessions', () => {
    service.sessions.mockReturnValue(of([]));
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No sessions are available');
  });

  it('defaults to an ended session when live access is unavailable', () => {
    const active = {
      ...sampleSession,
      session_key: 9999,
      date_start: new Date(Date.now() - 60000).toISOString(),
      date_end: new Date(Date.now() + 60000).toISOString(),
    };
    service.sessions.mockReturnValue(of([active, sampleSession]));
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('.session-select select');
    expect(select?.value).toBe('9165');
    expect(fixture.componentInstance.selected()?.session_key).toBe(9165);
    fixture.componentInstance.choose('9999');
    expect(fixture.componentInstance.status()).toBe('LIVE ACCESS LOCKED');
    expect(service.snapshot).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.snapshot()).toBeNull();
  });

  it('retains old values with explicit stale/error state on refresh failure', () => {
    const fixture = TestBed.createComponent(App);
    service.snapshot.mockReturnValue(throwError(() => new Error('offline')));
    fixture.componentInstance.refresh();
    expect(fixture.componentInstance.snapshot()).toBe(sampleSnapshot);
    expect(fixture.componentInstance.stale()).toBe(true);
    expect(fixture.componentInstance.error()).not.toBe('');
  });

  it('skips a recently ended session and explains its paid access window', () => {
    const recent = {
      ...sampleSession,
      session_key: 9999,
      date_start: new Date(Date.now() - 7200000).toISOString(),
      date_end: new Date(Date.now() - 60000).toISOString(),
    };
    service.sessions.mockReturnValue(of([recent, sampleSession]));
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance.selected()?.session_key).toBe(9165);
    fixture.componentInstance.choose('9999');
    fixture.detectChanges();
    expect(fixture.componentInstance.status()).toBe('ARCHIVE PENDING');
    expect(service.snapshot).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.textContent).toContain('30 minutes after the scheduled end');
  });

  it('does not overlap refresh requests and cleans up in-flight work', () => {
    const pending = new Subject<Snapshot>();
    service.snapshot.mockReturnValue(pending);
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.refresh();
    fixture.componentInstance.refresh();
    expect(service.snapshot).toHaveBeenCalledTimes(1);
    expect(pending.observed).toBe(true);
    fixture.destroy();
    expect(pending.observed).toBe(false);
  });

  it('only labels an active authenticated session with fresh timing as live', () => {
    service.config.mockReturnValue(of({ liveEnabled: true }));
    const active = {
      ...sampleSession,
      date_start: new Date(Date.now() - 300000).toISOString(),
      date_end: new Date(Date.now() + 300000).toISOString(),
    };
    service.sessions.mockReturnValue(of([active]));
    const data = {
      ...sampleSnapshot,
      fetchedAt: Date.now(),
      positions: [{ driver_number: 55, position: 1, date: new Date().toISOString() }],
    };
    service.snapshot.mockReturnValue(of(data));
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance.live()).toBe(true);
    fixture.componentInstance.now.set(Date.now() + 100000);
    expect(fixture.componentInstance.live()).toBe(false);
    expect(fixture.componentInstance.stale()).toBe(true);
    fixture.destroy();
  });

  it('polls only active sessions and stops polling while paused or destroyed', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    service.config.mockReturnValue(of({ liveEnabled: true }));
    service.sessions.mockReturnValue(
      of([
        {
          ...sampleSession,
          date_start: new Date(Date.now() - 60000).toISOString(),
          date_end: new Date(Date.now() + 600000).toISOString(),
        },
      ]),
    );
    const fixture = TestBed.createComponent(App);
    expect(service.snapshot).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30000);
    expect(service.snapshot).toHaveBeenCalledTimes(2);
    fixture.componentInstance.togglePause();
    vi.advanceTimersByTime(60000);
    expect(service.snapshot).toHaveBeenCalledTimes(2);
    fixture.componentInstance.togglePause();
    expect(service.snapshot).toHaveBeenCalledTimes(3);
    fixture.destroy();
    vi.advanceTimersByTime(60000);
    expect(service.snapshot).toHaveBeenCalledTimes(3);
  });

  it('does not poll recorded sessions even with live access configured', () => {
    vi.useFakeTimers();
    service.config.mockReturnValue(of({ liveEnabled: true }));
    const fixture = TestBed.createComponent(App);
    vi.advanceTimersByTime(180000);
    expect(service.snapshot).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('cancels the previous session load when switching selections', () => {
    const pending = new Subject<Snapshot>();
    service.snapshot.mockReturnValueOnce(pending).mockReturnValue(of(sampleSnapshot));
    service.sessions.mockReturnValue(of([sampleSession, { ...sampleSession, session_key: 9999 }]));
    const fixture = TestBed.createComponent(App);
    expect(pending.observed).toBe(true);
    fixture.componentInstance.choose('9999');
    expect(pending.observed).toBe(false);
    expect(fixture.componentInstance.selected()?.session_key).toBe(9999);
  });
});
