import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, concatMap, map, of, throwError, timeout, timer } from 'rxjs';
import {
  Driver,
  Interval,
  Lap,
  Position,
  RaceMessage,
  Result,
  Session,
  Snapshot,
  Weather,
} from './openf1.models';
import { latestByDriver, sessionPhase } from './dashboard.utils';

export function apiError(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 401 || error.status === 403)
      return 'Live data requires an active OpenF1 subscription and server-side authentication. Choose an ended session for free historical data.';
    if (error.status === 429)
      return 'OpenF1 rate limit reached. Updates are backing off; please wait before retrying.';
    if (error.status === 0)
      return 'Cannot reach the API gateway. Check your connection and that the local server is running.';
    return `OpenF1 request failed (HTTP ${error.status}). Please try again later.`;
  }
  return error instanceof Error && error.name === 'TimeoutError'
    ? 'OpenF1 took too long to respond. Please try again.'
    : 'Unexpected data error. Please refresh or choose another session.';
}

@Injectable({ providedIn: 'root' })
export class OpenF1Service {
  private readonly http = inject(HttpClient);

  config(): Observable<{ liveEnabled: boolean }> {
    return this.http.get<{ liveEnabled: boolean }>('/api/config').pipe(timeout(10_000));
  }

  get<T>(endpoint: string, query: Record<string, string | number>): Observable<T[]> {
    return this.http
      .get<T[]>(`https://api.openf1.org/v1/${endpoint}`, { params: new HttpParams({ fromObject: query }) })
      .pipe(
        timeout(25_000),
        map((data) => {
          if (!Array.isArray(data)) throw new Error('Invalid API response');
          return data;
        }),
        catchError((error: unknown) =>
          error instanceof HttpErrorResponse &&
          error.status === 404 &&
          error.error?.detail === 'No results found.'
            ? of<T[]>([])
            : throwError(() => error),
        ),
      );
  }

  sessions(year: number): Observable<Session[]> {
    return this.get<Session>('sessions', { year }).pipe(
      map((rows) => rows.sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start))),
    );
  }

  latest(): Observable<Session[]> {
    return this.get<Session>('sessions', { session_key: 'latest' });
  }

  snapshot(session: Session, previous?: Snapshot): Observable<Snapshot> {
    const now = Date.now();
    const ended = sessionPhase(session, now) === 'recorded';
    const end = Math.min(now, Date.parse(session.date_end));
    const start = Math.max(Date.parse(session.date_start), end - (ended ? 30 : 5) * 60_000);
    const from = new Date(start).toISOString();
    const query = { session_key: session.session_key };
    const window = { ...query, 'date>': from, 'date<': new Date(end).toISOString() };
    const snapshot: Snapshot = {
      drivers: previous?.drivers ?? [],
      results: [],
      positions: previous?.positions ?? [],
      intervals: [],
      laps: [],
      weather: [],
      messages: [],
      warnings: [],
      fetchedAt: now,
      windowStart: from,
    };
    const load = <T>(
      endpoint: string,
      params: Record<string, string | number>,
      assign: (data: T[]) => void,
    ) =>
      timer(1100).pipe(
        concatMap(() => this.get<T>(endpoint, params)),
        map((data) => {
          assign(data);
          return snapshot;
        }),
        catchError((error: unknown) => {
          // Connection/auth/rate failures affect the whole cycle; retain the last snapshot.
          if (!(error instanceof HttpErrorResponse) || [0, 401, 403, 429].includes(error.status)) {
            return throwError(() => error);
          }
          snapshot.warnings.push(`${endpoint}: ${apiError(error)}`);
          return of(snapshot);
        }),
      );

    return (
      snapshot.drivers.length
        ? of(snapshot)
        : load<Driver>('drivers', query, (rows) => (snapshot.drivers = rows))
    ).pipe(
      concatMap(() =>
        ended
          ? load<Result>('session_result', query, (rows) => (snapshot.results = rows))
          : of(snapshot),
      ),
      concatMap(() =>
        ended && snapshot.results.length
          ? of(snapshot)
          : load<Position>(
              'position',
              {
                ...window,
                'date>': previous
                  ? from
                  : new Date(
                      Math.max(Date.parse(session.date_start), end - 30 * 60_000),
                    ).toISOString(),
              },
              (rows) => {
                // Position is a change feed; unchanged drivers need their last known position retained.
                snapshot.positions = [
                  ...latestByDriver([...snapshot.positions, ...rows], (row) => row.date).values(),
                ];
              },
            ),
      ),
      concatMap(() =>
        session.session_type === 'Race' && !snapshot.results.length
          ? load<Interval>('intervals', window, (rows) => (snapshot.intervals = rows))
          : of(snapshot),
      ),
      concatMap(() =>
        load<Lap>(
          'laps',
          { ...query, 'date_start>': from, 'date_start<': new Date(end).toISOString() },
          (rows) => (snapshot.laps = rows),
        ),
      ),
      concatMap(() => load<Weather>('weather', window, (rows) => (snapshot.weather = rows))),
      concatMap(() =>
        load<RaceMessage>('race_control', window, (rows) => (snapshot.messages = rows)),
      ),
      map(() => ({ ...snapshot, fetchedAt: Date.now() })),
    );
  }
}
