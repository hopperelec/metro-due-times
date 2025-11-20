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
