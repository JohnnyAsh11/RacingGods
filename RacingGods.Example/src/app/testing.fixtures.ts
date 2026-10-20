import { Session, Snapshot } from './openf1.models';

export const sampleSession: Session = {
  session_key: 9165,
  meeting_key: 1219,
  session_name: 'Race',
  session_type: 'Race',
  date_start: '2023-09-17T12:00:00Z',
  date_end: '2023-09-17T14:00:00Z',
  circuit_short_name: 'Singapore',
  country_name: 'Singapore',
  country_code: 'SGP',
  location: 'Marina Bay',
  year: 2023,
};

export const sampleSnapshot: Snapshot = {
  drivers: [
    {
      driver_number: 55,
      full_name: 'Carlos SAINZ',
      name_acronym: 'SAI',
      team_name: 'Ferrari',
      team_colour: 'F91536',
    },
  ],
  positions: [],
  intervals: [],
  laps: [],
  results: [],
  weather: [],
  messages: [],
  fetchedAt: Date.parse('2023-09-17T14:00:00Z'),
  windowStart: '2023-09-17T13:30:00Z',
  warnings: [],
};
