import {
  formatGap,
  formatLap,
  latestByDriver,
  publiclyAvailable,
  retryDelay,
  sessionPhase,
  standings,
} from './dashboard.utils';
import { Snapshot } from './openf1.models';
import { sampleSession, sampleSnapshot } from './testing.fixtures';

describe('dashboard data semantics', () => {
  it('respects the paid access window for thirty minutes after scheduled end', () => {
    expect(publiclyAvailable(sampleSession, Date.parse('2023-09-17T14:01:00Z'))).toBe(false);
    expect(publiclyAvailable(sampleSession, Date.parse('2023-09-17T14:30:00Z'))).toBe(false);
    expect(publiclyAvailable(sampleSession, Date.parse('2023-09-17T14:31:00Z'))).toBe(true);
  });
  it('does not confuse latest or a future session with live data', () => {
    expect(sessionPhase(sampleSession, Date.parse('2026-09-16'))).toBe('recorded');
    expect(sessionPhase(sampleSession, Date.parse('2023-09-16'))).toBe('upcoming');
    expect(sessionPhase(sampleSession, Date.parse('2023-09-17T13:00:00Z'))).toBe('active');
    expect(
      sessionPhase({ ...sampleSession, is_cancelled: true }, Date.parse('2023-09-17T13:00:00Z')),
    ).toBe('cancelled');
  });

  it('uses timestamps rather than response order', () => {
    const rows = [
      { driver_number: 55, date: '2023-09-17T13:02:00Z', position: 2 },
      { driver_number: 55, date: '2023-09-17T13:01:00Z', position: 1 },
    ];
    expect(latestByDriver(rows, (row) => row.date).get(55)?.position).toBe(2);
  });

  it('ignores missing and invalid timestamps rather than claiming they are latest', () => {
    const rows = [
      { driver_number: 55, date: null, position: 1 },
      { driver_number: 55, date: 'invalid', position: 2 },
      { driver_number: 55, date: '2023-09-17T13:01:00Z', position: 3 },
    ];
    expect(latestByDriver(rows, (row) => row.date).get(55)?.position).toBe(3);
  });

  it('keeps unavailable data missing instead of inventing zeros', () => {
    const row = standings(sampleSnapshot, false)[0];
    expect(row.position).toBeNull();
    expect(row.gap).toBeNull();
    expect(row.lapTime).toBeNull();
    expect(formatGap(null)).toBe('--');
    expect(formatLap(null)).toBe('--');
  });

  it('formats numeric and lapped gaps without losing provider strings', () => {
    expect(formatGap(0)).toBe('LEADER');
    expect(formatGap(4.351)).toBe('+4.351');
    expect(formatGap('+1 LAP')).toBe('+1 LAP');
    expect(formatLap(89.123)).toBe('1:29.123');
    expect(formatLap(59.9996)).toBe('1:00.000');
  });

  it('prefers final results and does not reuse a retired driver position', () => {
    const snapshot: Snapshot = {
      ...sampleSnapshot,
      positions: [{ driver_number: 55, position: 1, date: '2023-09-17T13:45:00Z' }],
      intervals: [
        { driver_number: 55, gap_to_leader: 0, interval: 0, date: '2023-09-17T13:45:00Z' },
      ],
      results: [
        {
          driver_number: 55,
          position: null,
          dnf: true,
          dns: false,
          dsq: false,
          number_of_laps: 43,
          duration: null,
          gap_to_leader: null,
        },
      ],
    };
    const row = standings(snapshot, true)[0];
    expect(row.position).toBeNull();
    expect(row.gap).toBeNull();
    expect(row.interval).toBeNull();
    expect(row.status).toBe('DNF');
    expect(row.lap).toBe(43);
  });

  it('does not present qualifying segment arrays as race gaps', () => {
    const snapshot: Snapshot = {
      ...sampleSnapshot,
      results: [
        {
          driver_number: 55,
          position: 1,
          dnf: false,
          dns: false,
          dsq: false,
          number_of_laps: 12,
          duration: [90, 89, 88],
          gap_to_leader: [0, 0, 0],
        },
      ],
    };
    expect(standings(snapshot, true)[0].gap).toBeNull();
  });

  it('backs off and caps polling at two minutes', () => {
    expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([30000, 30000, 60000, 120000, 120000]);
  });
});
