import {LocationCode, StationCode} from "./types";
import {PlatformNumber} from "metro-api-client";

export function getOrSet<K, V>(map: Map<K, V>, key: K, defaultValue: V): V {
    if (!map.has(key)) {
        map.set(key, defaultValue);
    }
    return map.get(key)!;
}

export function findMostFrequentKeyInFrequencyMap<T>(frequencyMap: Map<T, number>): T | null {
    let mostFrequentKey: T | null = null;
    let highestFrequency = 0;
    for (const [key, frequency] of frequencyMap.entries()) {
        if (frequency > highestFrequency) {
            highestFrequency = frequency;
            mostFrequentKey = key;
        }
    }
    return mostFrequentKey;
}

export function toLocationCode(stationCode: StationCode, platform: PlatformNumber): LocationCode {
    return `${stationCode}_${platform}`;
}

export function toSecondsSinceMidnight(date: Date): number {
    return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

// Everything below is copied from metro-status-bot

const LOCATION_REGEX = new RegExp(/^(?<station>[A-Z]{3})(_(?<platform>\d+))?$/);
export function parseLocation(location: string): {
    station: StationCode,
    platform?: PlatformNumber
} | undefined {
    const match = location.match(LOCATION_REGEX);
    if (match?.groups) {
        return {
            station: match.groups.station,
            platform: match.groups.platform ? +match.groups.platform as PlatformNumber : undefined
        };
    }
}

const IGNORE_PLATFORM_STATIONS = ['APT', 'SHL', 'SJM', 'SSS', 'PJC'];
const MONUMENT_STATION_CODES = ["MMT","MTS","MTW","MTN","MTE"];

export function locationsMatch(location1: string, location2: string) {
    if (location1 === location2) return true;
    const parsedLocation1 = parseLocation(location1);
    const parsedLocation2 = parseLocation(location2);
    if (!parsedLocation1 || !parsedLocation2) return false;
    if (
        parsedLocation1.platform !== undefined &&
        parsedLocation2.platform !== undefined &&
        parsedLocation1.platform !== parsedLocation2.platform &&
        !IGNORE_PLATFORM_STATIONS.includes(parsedLocation1.station)
    ) return false;
    if (parsedLocation1.station === parsedLocation2.station) return true;
    return MONUMENT_STATION_CODES.includes(parsedLocation1.station) &&
        MONUMENT_STATION_CODES.includes(parsedLocation2.station);
}