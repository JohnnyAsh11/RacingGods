import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Subscription, concatMap } from 'rxjs';
import { apiError, OpenF1Service } from './openf1.service';
import { Session, Snapshot } from './openf1.models';
import {
  formatGap,
  formatLap,
  publiclyAvailable,
  retryDelay,
  sessionPhase,
  standings,
} from './dashboard.utils';

@Component({
  selector: 'app-root',
  imports: [DatePipe],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  private readonly api = inject(OpenF1Service);
  private request?: Subscription;
  private catalogRequest?: Subscription;
  private poll?: ReturnType<typeof setTimeout>;
  private failures = 0;
  readonly now = signal(Date.now());
  readonly year = signal(new Date().getFullYear());
  readonly years = Array.from(
    { length: new Date().getFullYear() - 2022 },
    (_, i) => new Date().getFullYear() - i,
  );
  readonly sessions = signal<Session[]>([]);
  readonly selected = signal<Session | null>(null);
  readonly snapshot = signal<Snapshot | null>(null);
  readonly loading = signal(true);
  readonly catalogLoading = signal(true);
  readonly error = signal('');
  readonly liveEnabled = signal(false);
  readonly paused = signal(false);
  readonly filter = signal('all');
  readonly phase = computed(() =>
    this.selected() ? sessionPhase(this.selected()!, this.now()) : 'idle',
  );
  readonly accessLocked = computed(
    () =>
      !!this.selected() &&
      !this.liveEnabled() &&
      (this.phase() === 'active' || this.phase() === 'recorded') &&
      !publiclyAvailable(this.selected()!, this.now()),
  );
  readonly rows = computed(() =>
    this.snapshot() ? standings(this.snapshot()!, this.phase() === 'recorded') : [],
  );
  readonly weather = computed(
    () =>
      [...(this.snapshot()?.weather ?? [])].sort(
        (a, b) => Date.parse(b.date) - Date.parse(a.date),
      )[0],
  );
  readonly messages = computed(() =>
    [...(this.snapshot()?.messages ?? [])]
      .filter(
        (row) => this.filter() === 'all' || (this.filter() === 'flags' ? !!row.flag : !row.flag),
      )
      .sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''))
      .slice(0, 40),
  );
  readonly dataTime = computed(() => {
    const data = this.snapshot();
    if (!data) return 0;
    return Math.max(
      0,
      ...data.positions.map((r) => Date.parse(r.date)),
      ...data.intervals.map((r) => Date.parse(r.date)),
      ...data.laps.map((r) => (r.date_start ? Date.parse(r.date_start) : 0)),
    );
  });
  readonly live = computed(
    () =>
      this.phase() === 'active' &&
      this.liveEnabled() &&
      !this.paused() &&
      !this.error() &&
      !this.snapshot()?.warnings.length &&
      this.dataTime() > 0 &&
      this.now() - this.dataTime() < 90_000,
  );
  readonly stale = computed(
    () =>
      !!this.snapshot() &&
      (!!this.error() ||
        (this.phase() === 'active' && this.now() - this.snapshot()!.fetchedAt > 90_000) ||
        (this.phase() === 'active' && this.now() - this.dataTime() > 90_000)),
  );
  readonly status = computed(() =>
    this.live()
      ? 'LIVE'
      : this.phase() === 'recorded'
        ? this.accessLocked()
          ? 'ARCHIVE PENDING'
          : 'RECORDED'
        : this.phase() === 'upcoming'
          ? 'UPCOMING'
          : this.phase() === 'cancelled'
            ? 'CANCELLED'
            : this.phase() === 'active'
              ? this.paused()
                ? 'PAUSED'
                : this.liveEnabled()
                  ? 'AWAITING DATA'
                  : 'LIVE ACCESS LOCKED'
              : 'NO SESSION',
  );
  readonly gap = formatGap;
  readonly lapTime = formatLap;

  constructor() {
    const clock = setInterval(() => this.now.set(Date.now()), 10_000);
    const visibility = () => {
      if (document.hidden) this.clearPoll();
      else if (!this.loading() && this.phase() === 'active' && this.liveEnabled() && !this.paused())
        this.refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    inject(DestroyRef).onDestroy(() => {
      this.request?.unsubscribe();
      this.catalogRequest?.unsubscribe();
      this.clearPoll();
      clearInterval(clock);
      document.removeEventListener('visibilitychange', visibility);
    });
    this.latest();
  }

  latest(): void {
    this.reset();
    this.catalogRequest = this.api
      .config()
      .pipe(
        concatMap((config) => {
          this.liveEnabled.set(config.liveEnabled);
          return this.api.latest();
        }),
        concatMap((latest) => {
          this.year.set(latest[0]?.year ?? new Date().getFullYear());
          return this.api.sessions(this.year());
        }),
      )
      .subscribe({
        next: (sessions) => this.acceptSessions(sessions),
        error: (error: unknown) => this.catalogError(error),
      });
  }

  changeYear(value: string): void {
    this.reset();
    this.year.set(Number(value));
    this.catalogRequest = this.api.sessions(this.year()).subscribe({
      next: (sessions) => this.acceptSessions(sessions),
      error: (error: unknown) => this.catalogError(error),
    });
  }

  choose(value: string): void {
    const session = this.sessions().find((row) => row.session_key === Number(value));
    if (!session) return;
    this.request?.unsubscribe();
    this.clearPoll();
    this.selected.set(session);
    this.snapshot.set(null);
    this.error.set('');
    this.paused.set(false);
    this.failures = 0;
    this.loading.set(false);
    this.refresh();
  }

  refresh(): void {
    this.clearPoll();
    const session = this.selected();
    if (!session) {
      this.latest();
      return;
    }
    if (this.loading()) return;
    this.now.set(Date.now());
    if (['upcoming', 'cancelled'].includes(this.phase()) || this.accessLocked()) return;
    this.loading.set(true);
    this.error.set('');
    this.request = this.api.snapshot(session, this.snapshot() ?? undefined).subscribe({
      next: (snapshot) => {
        this.snapshot.set(snapshot);
        this.now.set(Date.now());
        this.loading.set(false);
        this.failures = snapshot.warnings.length ? this.failures + 1 : 0;
        this.schedule();
      },
      error: (error: unknown) => {
        this.error.set(apiError(error));
        this.loading.set(false);
        this.failures++;
        this.schedule();
      },
    });
  }

  togglePause(): void {
    this.paused.update((value) => !value);
    if (this.paused()) {
      this.clearPoll();
      this.request?.unsubscribe();
      this.loading.set(false);
    } else this.refresh();
  }

  teamColor(value: string): string {
    return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : '#9aa6bb';
  }

  private acceptSessions(sessions: Session[]): void {
    this.sessions.set(sessions);
    this.catalogLoading.set(false);
    this.loading.set(false);
    const candidate =
      sessions.find((row) => {
        const phase = sessionPhase(row, Date.now());
        return (
          publiclyAvailable(row, Date.now()) ||
          (this.liveEnabled() && (phase === 'active' || phase === 'recorded'))
        );
      }) ?? sessions[sessions.length - 1];
    if (candidate) this.choose(String(candidate.session_key));
  }

  private reset(): void {
    this.request?.unsubscribe();
    this.catalogRequest?.unsubscribe();
    this.clearPoll();
    this.sessions.set([]);
    this.selected.set(null);
    this.snapshot.set(null);
    this.error.set('');
    this.loading.set(true);
    this.catalogLoading.set(true);
  }

  private catalogError(error: unknown): void {
    this.error.set(apiError(error));
    this.loading.set(false);
    this.catalogLoading.set(false);
  }

  private clearPoll(): void {
    if (this.poll) clearTimeout(this.poll);
    this.poll = undefined;
  }

  private schedule(): void {
    if (this.phase() === 'active' && this.liveEnabled() && !this.paused() && !document.hidden) {
      this.poll = setTimeout(() => this.refresh(), retryDelay(this.failures));
    }
  }
}
