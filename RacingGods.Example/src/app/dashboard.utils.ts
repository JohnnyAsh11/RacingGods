import { Gap, Session, Snapshot, Standing } from './openf1.models';

export function publiclyAvailable(session: Session, now: number): boolean {
  return !session.is_cancelled && now > Date.parse(session.date_end) + 30 * 60_000;
}

export function sessionPhase(
  session: Session,
  now: number,
): 'upcoming' | 'active' | 'recorded' | 'cancelled' {
  if (session.is_cancelled) return 'cancelled';
  if (now < Date.parse(session.date_start)) return 'upcoming';
  return now <= Date.parse(session.date_end) ? 'active' : 'recorded';
}

export function latestByDriver<T extends { driver_number: number }>(
  records: T[],
  timestamp: (record: T) => string | null,
): Map<number, T> {
  const latest = new Map<number, T>();
  for (const record of records) {
    const date = Date.parse(timestamp(record) ?? '');
    if (!Number.isFinite(date)) continue;
    const previous = latest.get(record.driver_number);
    if (!previous || date > Date.parse(timestamp(previous) ?? '')) {
      latest.set(record.driver_number, record);
    }
  }
  return latest;
}

export function standings(snapshot: Snapshot, finalResults: boolean): Standing[] {
  const positions = latestByDriver(snapshot.positions, (row) => row.date);
  const intervals = latestByDriver(snapshot.intervals, (row) => row.date);
  const laps = latestByDriver(snapshot.laps, (row) => row.date_start);
  const results = new Map(snapshot.results.map((row) => [row.driver_number, row]));
  return snapshot.drivers
    .map((driver): Standing => {
      const position = positions.get(driver.driver_number);
      const interval = intervals.get(driver.driver_number);
      const lap = laps.get(driver.driver_number);
      const result = finalResults ? results.get(driver.driver_number) : undefined;
      return {
        driver,
        position: result ? result.position : (position?.position ?? null),
        gap: result
          ? Array.isArray(result.gap_to_leader)
            ? null
            : result.gap_to_leader
          : (interval?.gap_to_leader ?? null),
        interval: result ? null : (interval?.interval ?? null),
        lap: result?.number_of_laps ?? lap?.lap_number ?? null,
        lapTime: lap?.lap_duration ?? null,
        status: result?.dsq ? 'DSQ' : result?.dns ? 'DNS' : result?.dnf ? 'DNF' : '',
        date: position?.date ?? null,
      };
    })
    .sort(
      (a, b) =>
        (a.position ?? 999) - (b.position ?? 999) ||
        a.driver.driver_number - b.driver.driver_number,
    );
}

export function formatGap(value: Gap): string {
  if (value === null || value === undefined) return '--';
  if (typeof value === 'string') return value;
  if (value === 0) return 'LEADER';
  return `${value > 0 ? '+' : ''}${value.toFixed(3)}`;
}

export function formatLap(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--';
  const milliseconds = Math.round(seconds * 1000);
  return `${Math.floor(milliseconds / 60000)}:${(Math.floor(milliseconds / 1000) % 60).toString().padStart(2, '0')}.${(milliseconds % 1000).toString().padStart(3, '0')}`;
}

export function retryDelay(failures: number): number {
  return Math.min(120_000, 30_000 * 2 ** Math.max(0, failures - 1));
}
