import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import * as Models from './openf1.models'
import { catchError, concatMap, map, Observable, of, pipe, throwError, timeout, timer } from 'rxjs';
import { RaceMessage, Session, Snapshot, Weather } from './openf1.models';
import { latestByDriver } from './openf1.helper';

@Injectable({ providedIn: 'root' })
export class OpenF1Client {
    private readonly httpClient = inject(HttpClient);
    private readonly url = 'https://api.openf1.org/v1/'; 
    private readonly rateLimit = 1100;

    // Generic Get method for easy interactions with the OpenF1 API.
    get<T>(endpoint: string, query: Record<string, string | number>) {
        const errTimeout = 25_000;
        const uri = `${this.url}${endpoint}`;

        var resp = this.httpClient.get<T[]>(uri, { params: new HttpParams({ fromObject: query }) })

        return resp.pipe(
            // Timeout if a query takes too long.
            timeout(errTimeout),

            // Ensuring the response data it is valid.
            map((data) => {
                if (!Array.isArray(data)) {
                    throw new Error("The API returned an unexpected response.");
                }
                return data;
            }),

            // Performing smooth error handling.
            catchError((error: unknown) => {
                if (error instanceof HttpErrorResponse &&
                    error.status === 404 && 
                    error.error?.detail === 'No results found.') {
                    return of<T[]>([]);
                }
                return throwError(() => error);
            })
        );
    }

    // Test use of the Get method.
    sessions(year: number): Observable<Models.Session[]> {  
        var sessionsResp = this.get<Models.Session>('sessions', { year });

        sessionsResp = sessionsResp.pipe(
            map((rows) => rows.sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start))),
        );

        return sessionsResp;
    }

    // Getting the latest avaliable session.
    latestSession(): Observable<Session[]> {
        return this.get<Session>('sessions', { session_key: 'latest' });
    }

    // Helper function for data loading for snapshots.
    private loadRecord<T>(
        endpoint: string,
        params: Record<string, string | number>,
        snapshot: Snapshot,
        assignData: (data: T[]) => void): Observable<Snapshot> {
        // Handling API rate limiting.
        return timer(this.rateLimit).pipe(

            // Getting and mapping data from the API.
            concatMap(() => this.get<T>(endpoint, params)),
            map((data) => {
                assignData(data);
                return snapshot;
            }),

            // Error handling for API responses.
            catchError((error: unknown) => {
                if (error instanceof HttpErrorResponse && ![0, 401, 403, 429].includes(error.status)) {
                    return of(snapshot);
                }

                return throwError(() => error);
            })
        );
    }

    // Getting a snapshot of data for a given session.
    snapshot(session: Session, previous?: Snapshot): Observable<Snapshot> {
        const now = Date.now();
        const ended = 0; // TODO: Figure out a way to determin state of the session.

        // Calculating timeframes.
        const end = Math.min(now, Date.parse(session.date_end));
        const start = Math.max(Date.parse(session.date_start), end - (ended ? 30 : 5) * 60_000);

        const from = new Date(start).toISOString();
        const query = { session_key: session.session_key };
        const window = { 
            ...query, 
            'date>': from, 
            'date<': new Date(end).toISOString() };
        
        // Creating the snapshot object.
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

        // Loading the driver data into the snapshot.
        snapshot.drivers.length 
            ? of(snapshot) : 
            this.loadRecord<Models.Driver>('drivers', query, snapshot, (data) => snapshot.drivers = data);

        pipe(
            // Loading the results data into the snapshot.
            concatMap(() => ended 
                ? this.loadRecord<Models.Result>('session_results', query, snapshot, (data) => snapshot.results = data) 
                : of(snapshot)),

            // Loading the Position data into the snapshot.
            concatMap(() => ended && snapshot.results.length 
                ? of(snapshot) 
                : this.loadRecord<Models.Position>('positions',
                    {
                        ...window,
                        'date>': previous ? from : new Date(Math.max(Date.parse(session.date_start), end - 30 * 60_000)).toISOString(),
                    },
                    snapshot,
                    (data) => {
                        snapshot.positions = [...latestByDriver([...snapshot.positions, ...data], (data) => data.date).values(),];
                    }
                )
            ),

            // Loading the Intervals into the snapshot.
            concatMap(() => session.session_type === 'Race' && !snapshot.results.length 
                ? this.loadRecord<Models.Interval>('intervals', window, snapshot, (data) => (snapshot.intervals = data)) 
                : of(snapshot)),

            // Loading the Laps into the snapshot.
            concatMap(() => this.loadRecord<Models.Lap>('laps', 
                    { ...query, 'date_start>': from, 'date_start<': new Date(end).toISOString() },
                    snapshot,
                    (data) => (snapshot.laps = data)
                ),
            ),
            
            // Loading the Weather accosiated with the session into the snapshot.
            concatMap(() => this.loadRecord<Weather>('weather', window, snapshot, (data) => (snapshot.weather = data))),
            
            // Loading the Race Control messages about the session into the snapshot.
            concatMap(() => this.loadRecord<RaceMessage>('race_control', window, snapshot, (data) => (snapshot.messages = data))),

            // Returning the snapshot object with the timestamp the data was received.
            map(() => ({ ...snapshot, fetchedAt: Date.now() }))
        );

        // Returning the snapshot object.
        return of(snapshot);            
    }
}