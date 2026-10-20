export interface Session {
  session_key: number;
  meeting_key: number;
  session_name: string;
  session_type: string;
  date_start: string;
  date_end: string;
  circuit_short_name: string;
  country_name: string;
  country_code: string;
  location: string;
  year: number;
  is_cancelled?: boolean;
}

export interface Driver {
  driver_number: number;
  full_name: string;
  name_acronym: string;
  team_name: string;
  team_colour: string;
}

export interface Position {
  date: string;
  driver_number: number;
  position: number;
}

export type Gap = number | string | null;

export interface Interval {
  date: string;
  driver_number: number;
  gap_to_leader: Gap;
  interval: Gap;
}

export interface Lap {
  date_start: string | null;
  driver_number: number;
  lap_number: number;
  lap_duration: number | null;
  is_pit_out_lap: boolean;
}

export interface Result {
  driver_number: number;
  position: number | null;
  number_of_laps: number;
  duration: number | (number | null)[] | null;
  gap_to_leader: Gap | Gap[];
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
}

export interface Weather {
  date: string;
  air_temperature: number | null;
  track_temperature: number | null;
  humidity: number | null;
  wind_speed: number | null;
  rainfall: number | null;
}

export interface RaceMessage {
  date: string | null;
  category: string;
  flag: string | null;
  message: string;
  lap_number: number | null;
  driver_number: number | null;
}

export interface Snapshot {
  drivers: Driver[];
  positions: Position[];
  intervals: Interval[];
  laps: Lap[];
  results: Result[];
  weather: Weather[];
  messages: RaceMessage[];
  warnings: string[];
  fetchedAt: number;
  windowStart: string;
}

export interface Standing {
  driver: Driver;
  position: number | null;
  gap: Gap;
  interval: Gap;
  lap: number | null;
  lapTime: number | null;
  status: string;
  date: string | null;
}
