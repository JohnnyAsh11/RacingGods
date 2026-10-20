import { Session } from "./openf1.models";

// Helper function to get the latest record for each driver based on a timestamp.
export function latestByDriver<T extends { driver_number: number }>(
    records: T[],
    timestamp: (record: T) => string | null): Map<number, T> {
    const latest = new Map<number, T>();

    // Iterating through the records to find the latest record for each driver.
    for (const record of records) {
        const date = Date.parse(timestamp(record) ?? '');

        if (!Number.isFinite(date)) {
            continue;
        }

        const previous = latest.get(record.driver_number);

        if (!previous || date > Date.parse(timestamp(previous) ?? '')) {
            latest.set(record.driver_number, record);
        }
    }
    return latest;
}

// Helper function to determine the phase of a session based on the current time.
// Returns one of the four string for ease of use.
export function sessionPhase(
    session: Session,
    now: number): 'upcoming' | 'active' | 'recorded' | 'cancelled' {
    if (session.is_cancelled) {
        return 'cancelled';
    }
    if (now < Date.parse(session.date_start)) {
        return 'upcoming';
    }
    return now <= Date.parse(session.date_end) ? 'active' : 'recorded';
}