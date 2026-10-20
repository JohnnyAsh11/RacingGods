# OpenF1 / Pit Wall

A standalone Angular 22 dashboard for real OpenF1 data: session selection, circuit metadata, driver classification and timing, weather, and race-control messages. Dark motorsport styling, responsive layouts, keyboard-accessible controls, and explicit recorded/live/empty/loading/error/stale states.

**Historical data works without an account. Paid live access is optional. No sample or fabricated racing data is shown in the application.** Test fixtures are used only by tests.

## Run locally

Requires Node.js 24 LTS (validated with 24.21.0) and npm.

```powershell
npm.cmd install
npm.cmd start
```

Open **http://127.0.0.1:4200**. The start script runs Angular on port 4200 and the loopback-only API gateway on port 8787. Stop both with Ctrl+C. Neither credentials nor subscriptions are needed for the default archive mode.

Node was not initially installed on this machine. A portable official Node distribution was installed outside the project. To use it in a fresh PowerShell window on this machine:

```powershell
$env:Path = "C:\Users\JFagerlin\.copilot\session-state\73ad95bd-7316-4f36-a1e0-22645498e774\files\node-v24.21.0-win-x64;$env:Path"
Set-Location C:\Users\JFagerlin\Desktop\OpenF1
npm.cmd start
```

Alternatively, install Node 24 LTS normally and use the standard commands above. Dependencies are already installed in this workspace.

## Using the dashboard

- **Latest available** resolves OpenF1's latest session, then selects the newest session in that season that ended over 30 minutes ago by default. `latest` does not mean live. With live credentials configured, a currently scheduled session can be selected automatically.
- **Season / Session** lets you browse recorded sessions from 2023 onward, including practice, qualifying, sprint and race sessions when available.
- Ended sessions use `session_result` when available. Otherwise, positions come from the latest samples in the query window and are explicitly **not** described as final classification.
- Race gaps preserve numeric values and provider strings such as `+1 LAP`. Race intervals are only requested when a final classification is unavailable. Qualifying segment arrays are not misrepresented as race gaps.
- **Last sample** is the latest reported lap duration in the bounded window, not a fastest lap. `--` means unavailable, not zero. DNF, DNS and DSQ are retained from final results.
- Weather has its own observation timestamp. Race-control filters show all messages, flags or notices, newest first (at most 40 displayed). Times are UTC.
- Decorative circuit-card graphics are abstract artwork, not circuit layouts or telemetry.

## Optional genuine live access

OpenF1's official documentation states that historical data from 2023 onward is free, while real-time data requires a **paid OpenF1 subscription**. This project does not buy access, supply an account, or bypass that requirement.

Obtain a valid REST bearer access token through the [official authentication guide](https://openf1.org/auth.html). The documented exchange is `POST https://api.openf1.org/token` with `application/x-www-form-urlencoded` fields `username` and `password`. Perform that exchange in a trusted server/terminal, never in browser code. The response supplies `access_token`, `token_type`, and `expires_in`; tokens expire after **one hour**. The docs require requesting a new token, not a refresh-token grant.

Set the token **only in the server process environment** before starting the app:

```powershell
# Enter securely rather than pasting a token into a source file or shell history.
$secureToken = Read-Host "OpenF1 access token" -AsSecureString
$env:OPENF1_ACCESS_TOKEN = [System.Net.NetworkCredential]::new("", $secureToken).Password
npm.cmd start
```

When finished, remove it from the current shell:

```powershell
Remove-Item Env:\OPENF1_ACCESS_TOKEN -ErrorAction SilentlyContinue
```

The Node gateway adds the bearer header on the server. The browser receives only a configuration flag; it never receives the token. Do not put credentials in Angular environment files, HTML, localStorage, URLs, committed files, or `public`. `.env` files are ignored but are **not automatically loaded**.

The gateway uses the token supplied at startup; it does not store a password or automatically refresh tokens. An expired/invalid token produces an explicit 401/403 error. Obtain a new token and restart the server. Remove the environment variable and restart to return to unauthenticated archive mode.

**LIVE** is shown only for a session inside its scheduled start/end window, with live access configured, fresh timing samples (under 90 seconds), and no active data error or pause. A configured token alone never makes recorded data live. Delayed provider data, scheduled-window inaccuracies, red flags, or a quiet track can leave a genuinely active session in **AWAITING DATA**. This is intentional; the app does not invent a live signal.

Live access could not be exercised against the paid API because no subscription credentials were supplied. Its polling, freshness, cancellation and error behavior are covered by deterministic tests.

## Request behavior and limitations

The app uses typed Angular `HttpClient` requests through a same-origin local gateway, not full-session high-frequency telemetry:

| Data                                        | Scope                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Sessions                                    | One season, or `session_key=latest`                                                                                               |
| Drivers and results                         | One selected session                                                                                                              |
| Race intervals, laps, weather, race control | Last 30 minutes before scheduled end for recorded sessions; last 5 minutes for active sessions                                    |
| Position changes                            | Initial seed of up to 30 minutes, then five-minute active windows, retaining the last observed position per driver while watching |

Data outside those windows, including a retired driver's last lap or messages from early in the race, is deliberately not fetched. Position is a sparse change feed, so a driver with no changes in the initial seed window may remain unranked until a new position is reported. Unchanged observed positions are retained, never inferred. Missing final results do not trigger unbounded history queries. Some sessions/endpoints are unavailable, especially older sessions, and the API may return no results.

Requests within a snapshot are sequential and spaced by at least 1.1 seconds. Active authenticated sessions refresh **30 seconds after completion**, not on overlapping intervals. Failures back off to 60 and then 120 seconds. Session/year changes cancel prior work, destroying the component cleans up subscriptions/timers, and hidden tabs stop scheduling new updates. Recorded sessions never auto-poll. The gateway additionally bounds, serializes and paces upstream requests, including across tabs, and enforces upstream rate-limit cooldowns.

The [official site](https://openf1.org/) publishes **3 requests/second AND 30/minute** for free access, and **6/second AND 60/minute** for paid access. The gateway conservatively spaces upstream calls by at least 2.1 seconds even with a paid token. Other applications sharing your IP/account can still consume quota.

OpenF1's visible FAQ defines its paid live-data window as **30 minutes before scheduled start through 30 minutes after scheduled end**. The anonymous default deliberately skips recently ended sessions; manually selecting one shows **ARCHIVE PENDING** instead of sending data requests that would require payment.

The public API was confirmed to send `Access-Control-Allow-Origin: *` on an actual GET. This project nevertheless uses a same-origin gateway to isolate optional credentials and centralize request limits. OpenF1 may change access policies, data availability or schemas; its service is external and not guaranteed by this project.

OpenF1 filter URLs use `date>...` / `date<...` comparisons. With `HttpParams` or `URLSearchParams`, comparator keys are `date>` and `date<` (or `date_start>` / `date_start<`), with the ISO timestamp as the value. Do not append an extra `=` to the parameter key. The real API's exact `404 {"detail":"No results found."}` response is treated as an empty result; other failures remain errors.

## Build and tests

```powershell
npm.cmd test -- --watch=false
npm.cmd run test:server
npm.cmd run build
npm.cmd run serve
```

The built site is served at **http://127.0.0.1:8787** with the same API gateway. The output directory is `dist\openf1-dashboard\browser`. Frontend tests use the official Angular scaffold's Vitest runner and HttpClient testing backend; gateway tests use the same installed Vitest dependency.

Frontend coverage includes session phase and live freshness, empty/error/partial data, timestamp ordering, final results and DNF, gap/lap formatting, query bounds and pacing, rate-limit termination, cancellation, pause/resume and avoiding historical polling.

## Architecture and deployment

- `src\app\openf1.models.ts`: API and view types.
- `src\app\openf1.service.ts`: typed, paced, bounded HTTP reads.
- `src\app\dashboard.utils.ts`: deterministic timing and classification logic.
- `src\app\app.ts`, `app.html`, `app.css`: state, polling lifecycle, accessible UI.
- `server`: allowlisted Node gateway and production static serving.
- `scripts`: development process launcher.

No database, analytics, or persistent credential store is used. Typography uses Google Fonts with system-font fallbacks; data and the application still work if fonts cannot load.

The supplied gateway is a **local single-user tool**, not a public authenticated service. Keep it loopback-only. For a hosted deployment, put a properly authenticated, HTTPS, rate-limited backend in front of the API, manage credentials in server-side secret storage, and review OpenF1's subscription and redistribution terms. Do not expose the supplied token-backed proxy publicly or host only the static files without its API routes. Angular's development server is not a production server.

## Sources

- [OpenF1 official API documentation](https://openf1.org/docs/) - access requirements, endpoint schemas and filtering.
- [OpenF1 authentication guide](https://openf1.org/auth.html) - server-side token exchange and one-hour lifetime.
- [OpenF1 homepage](https://openf1.org/) - published tier rate limits and live-data access window.
- [OpenF1 project](https://github.com/br-g/openf1) - upstream implementation.
- [Angular version compatibility](https://angular.dev/reference/versions).

Independent, unofficial project; not affiliated with Formula 1, the FIA, or OpenF1.
