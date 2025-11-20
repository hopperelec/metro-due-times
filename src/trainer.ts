import {
    ActiveTrainHistoryStatus, ActiveTrainState,
    ParsedLastSeen,
    parseLastSeen,
    parseTimesAPILocation, PlatformNumber,
    TimesApiData
} from "metro-api-client";
import NETWORK_GRAPH from './pop-network.json';
import fs from "fs/promises";
import {StationCode, LocationCode, FullStateKey, PathKey, TimeDeltaKey} from "./types";
import proxy, {apiConstants, getStationCode, reloadApiConstants} from "./proxy";

interface ConsistentLastSeen {
    state: ActiveTrainState
    stationCode: StationCode;
    platform: PlatformNumber;
    date: Date;
}

function toLocationCode(stationCode: StationCode, platform: PlatformNumber): LocationCode {
    return `${stationCode}_${platform}`;
}

function toFullStateKey(lastSeen: ConsistentLastSeen): FullStateKey {
    return `${lastSeen.state}-${toLocationCode(lastSeen.stationCode, lastSeen.platform)}`;
}

async function formatTimesApi(event: TimesApiData['lastEvent']): Promise<ConsistentLastSeen> {
    const { station, platform } = parseTimesAPILocation(event.location);
    let state = event.type.toLowerCase().replaceAll('_', ' ');
    state = state[0].toUpperCase() + state.slice(1); // Capitalize first letter
    return {
        state: state as ActiveTrainState,
        stationCode: await getStationCode(station, platform),
        platform,
        date: event.time,
    };
}

async function formatGeoApi(parsedLastSeen: ParsedLastSeen, date: Date): Promise<ConsistentLastSeen> {
    return {
        state: parsedLastSeen.state,
        stationCode: await getStationCode(parsedLastSeen.station, parsedLastSeen.platform),
        platform: parsedLastSeen.platform,
        date,
    };
}

function findMostFrequentKeyInFrequencyMap<T>(frequencyMap: Map<T, number>): T | null {
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

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
async function toConsistentLastSeen(status: ActiveTrainHistoryStatus, heartbeatDate: Date): Promise<ConsistentLastSeen> {
    const timesApi = status.timesAPI?.lastEvent;
    const geoApiString = status.trainStatusesAPI?.lastSeen;

    if (!geoApiString) {
        return formatTimesApi(timesApi);
    }

    const geoData = parseLastSeen(geoApiString);
    const geoDate = new Date(heartbeatDate);
    geoDate.setHours(geoData.hours, geoData.minutes, 0, 0);

    // Adjust geoDate to be within 12 hours of heartbeatDate
    const diff = geoDate.getTime() - heartbeatDate.getTime();
    if (diff < -TWELVE_HOURS_MS) {
        geoDate.setDate(geoDate.getDate() + 1);
    } else if (diff > TWELVE_HOURS_MS) {
        geoDate.setDate(geoDate.getDate() - 1);
    }

    if (!timesApi || geoDate.getTime() > timesApi.time.getTime()) {
        return formatGeoApi(geoData, geoDate);
    }
    return formatTimesApi(timesApi);
}

function getOrSet<K, V>(map: Map<K, V>, key: K, defaultValue: V): V {
    if (!map.has(key)) {
        map.set(key, defaultValue);
    }
    return map.get(key)!;
}

async function main() {
    console.log("Fetching API constants...");
    await reloadApiConstants();

    console.log("Fetched API constants. Fetching history summary...");
    const historySummary = await proxy.getHistorySummary();

    console.log(`Fetched history summary. Fetching and processing history for all ${Object.keys(historySummary.trains).length} TRNs...`);
    const allTimeDeltas = new Map<TimeDeltaKey, number[]>();
    const pathFrequencyMatrix = new Map<StationCode, Map<StationCode, Map<PathKey, number>>>(); // Current location -> Destination -> Path -> Frequency
    const destinationFrequencyMatrix = new Map<LocationCode, Map<LocationCode, Map<LocationCode, number>>>(); // Starting location -> Current location -> Final destination -> Frequency
    await Promise.all(
        Object.keys(historySummary.trains).map(async trn => {
            let latestTimestamp = new Date(0);
            let currentJourney: ConsistentLastSeen[] = [];
            while (true) {
                const history = await proxy.getTrainHistory(trn, {
                    time: { from: new Date(latestTimestamp.getTime() + 1) },
                    limit: apiConstants.MAX_HISTORY_REQUEST_LIMIT,
                });
                if (history.extract.length === 0) break;
                latestTimestamp = history.extract[history.extract.length - 1].date;
                for (const entry of history.extract) {
                    // Reset the current journey if entry is inactive
                    if (!entry.active) {
                        currentJourney = [];
                        continue;
                    }
                    // Identify most recent/precise last seen
                    let consistentLastSeen: ConsistentLastSeen;
                    try {
                        consistentLastSeen = await toConsistentLastSeen(entry.status, entry.date);
                    } catch (error) {
                        // For example, unrecognized station
                        currentJourney = [];
                        continue;
                    }
                    const locationCode = toLocationCode(consistentLastSeen.stationCode, consistentLastSeen.platform);
                    // Add current data to recent data
                    currentJourney.push(consistentLastSeen);
                    // Analyze recent data for paths and destinations
                    if (currentJourney.length >= 2) {
                        const prevEntry = currentJourney[currentJourney.length - 2];
                        const prevLocationCode = toLocationCode(prevEntry.stationCode, prevEntry.platform);
                        if (locationCode === prevLocationCode) {
                            if (consistentLastSeen.state === prevEntry.state) {
                                // Duplicate entry; skip entirely
                                continue;
                            }
                        // Reset the current journey if the latest location is not adjacent to the last one
                        } else if (!NETWORK_GRAPH[prevLocationCode]?.includes(locationCode)) {
                            currentJourney = [];
                        // If the current station was seen recently, assume the previous location was a terminus
                        } else if (currentJourney.some(entry =>
                                entry !== consistentLastSeen &&
                                entry.stationCode === consistentLastSeen.stationCode
                        )) {
                            const startingLocationCode = toLocationCode(currentJourney[0].stationCode, currentJourney[0].platform);
                            // Add to destination frequencies for all previous recent locations
                            for (const recentLocation of currentJourney) {
                                const recentLocationCode = toLocationCode(recentLocation.stationCode, recentLocation.platform);
                                const currentLocationMap = getOrSet(
                                    destinationFrequencyMatrix,
                                    startingLocationCode,
                                    new Map()
                                );
                                const destinationFrequencies = getOrSet(
                                    currentLocationMap,
                                    recentLocationCode,
                                    new Map()
                                );
                                destinationFrequencies.set(
                                    prevLocationCode,
                                    (destinationFrequencies.get(prevLocationCode) || 0) + 1
                                );
                            }
                            // Restart recent data from the last location
                            currentJourney = [prevEntry, consistentLastSeen];
                        }
                        // If the latest state is "Arrived", compare with all previous recent stations to build paths
                        for (let i = 0; i < currentJourney.length - 1; i++) {
                            const from = currentJourney[i];
                            const fromLocationCode = toLocationCode(from.stationCode, from.platform);
                            const to = consistentLastSeen;
                            const journeyLocationCodes = currentJourney
                                .slice(i + 1)
                                .map(loc => toLocationCode(loc.stationCode, loc.platform))
                                // Collapse consecutive duplicates
                                .filter((code, index, arr) => index === 0 || code !== arr[index - 1]);
                            const pathKey = journeyLocationCodes.join("->");
                            // Add to path frequency matrix
                            if (fromLocationCode !== journeyLocationCodes[journeyLocationCodes.length - 1]) {
                                // Path only depends on location, not on state
                                const destinationToPathFrequencies = getOrSet(
                                    pathFrequencyMatrix,
                                    toLocationCode(from.stationCode, from.platform),
                                    new Map()
                                );
                                const pathFrequencies = getOrSet(
                                    destinationToPathFrequencies,
                                    to.stationCode,
                                    new Map()
                                );
                                pathFrequencies.set(pathKey, (pathFrequencies.get(pathKey) || 0) + 1);
                            }
                            // Record time delta
                            getOrSet(
                                allTimeDeltas,
                                `${toFullStateKey(from)}->${pathKey}`,
                                []
                            ).push(to.date.getTime() - from.date.getTime());
                        }
                    }
                }
                if (history.extract.length < apiConstants.MAX_HISTORY_REQUEST_LIMIT) {
                    // Avoid empty or tailing requests
                    break;
                }
            }
            console.log(`Processed all history for T${trn}`);
        })
    );
    console.log(`Processed all history; found ${allTimeDeltas.size} unique time delta keys. Computing median times...`);

    const medianPathTimes = new Map<TimeDeltaKey, number>();
    for (const [key, deltas] of allTimeDeltas.entries()) {
        deltas.sort((a, b) => a - b);
        const mid = Math.floor(deltas.length / 2);
        const median = deltas.length % 2 !== 0 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
        medianPathTimes.set(key, median);
    }
    console.log("Computed median times. Computing usual paths...");

    const usualPaths = new Map<LocationCode, Map<StationCode, PathKey>>(); // Current location -> Destination -> Usual path
    for (const locationCode of pathFrequencyMatrix.keys()) {
        const destinationToPathFrequencies = pathFrequencyMatrix.get(locationCode)!;
        const destinationToUsualPath = new Map<LocationCode, PathKey>();
        for (const [destination, pathFrequencies] of destinationToPathFrequencies.entries()) {
            const usualPath = findMostFrequentKeyInFrequencyMap(pathFrequencies);
            if (usualPath) {
                destinationToUsualPath.set(destination, usualPath);
            }
        }
        usualPaths.set(locationCode, destinationToUsualPath);
    }
    console.log("Computed usual paths. Computing usual destinations...");

    const usualDestinations = new Map<LocationCode, Map<LocationCode, LocationCode>>(); // Starting location -> Current location -> Usual final destination
    for (const [startingLocation, currentLocationMap] of destinationFrequencyMatrix.entries()) {
        const currentToUsualDestination = new Map<LocationCode, LocationCode>();
        for (const [currentLocation, destinationFrequencies] of currentLocationMap.entries()) {
            const usualDestination = findMostFrequentKeyInFrequencyMap(destinationFrequencies);
            if (usualDestination) {
                currentToUsualDestination.set(currentLocation, usualDestination);
            }
        }
        usualDestinations.set(startingLocation, currentToUsualDestination);
    }
    console.log("Computed usual destinations. Saving models...");

    await fs.writeFile('models/medianPathTimes.json', JSON.stringify(Object.fromEntries(medianPathTimes)));
    await fs.writeFile('models/usualPaths.json', JSON.stringify(
        Object.fromEntries(
            Array.from(usualPaths.entries()).map(([k, v]) => [k, Object.fromEntries(v)])
        )
    ));
    await fs.writeFile('models/usualDestinations.json', JSON.stringify(
        Object.fromEntries(
            Array.from(usualDestinations.entries()).map(([k, v]) => [k, Object.fromEntries(v)])
        )
    ));
    console.log("Saved models to files. Done.");
}

main().catch((error) => {
    console.error("Error in main execution:", error);
    process.exit(1);
});
