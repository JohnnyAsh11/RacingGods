

export function latestByDriver<T extends { driver_number: number }>(
    records: T[],
    timestamp: (record: T) => string | null): Map<number, T> {
    const latest = new Map<number, T>();
    
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