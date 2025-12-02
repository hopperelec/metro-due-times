import fs from "fs/promises";
import {StationCode, LocationCode, PathKey, TimeDeltaKey} from "./types";
import proxy, {getApiConstants} from "./proxy";
import {FullState, MedianTimeDeltas, UsualDestinations, UsualPaths} from "./models";
import {findMostFrequentKeyInFrequencyMap, getOrSet} from "./utils";
import {isAdjacent} from "./network-graph";
import pLimit from "p-limit";

const MAX_CONCURRENT_REQUESTS = 5;

// TimeDeltaKey -> List of time deltas (in ms)
class TimeDeltaMap extends Map<TimeDeltaKey, number[]> {
    addDelta(key: TimeDeltaKey, delta: number) {
        getOrSet(this, key, []).push(delta);
    }

    computeMedians(): MedianTimeDeltas {
        const medianMap = new MedianTimeDeltas();
        for (const [key, deltas] of this.entries()) {
            deltas.sort((a, b) => a - b);
            const mid = Math.floor(deltas.length / 2);
            const median = deltas.length % 2 !== 0 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
            medianMap.set(key, median);
        }
        return medianMap;
    }
}

// Current location -> Destination -> Path -> Frequency
class PathFrequencyMatrix extends Map<StationCode, Map<StationCode, Map<PathKey, number>>> {
    addPath(from: StationCode, to: StationCode, path: PathKey) {
        const destinationToPathFrequencies = getOrSet(this, from, new Map());
        const pathFrequencies = getOrSet(destinationToPathFrequencies, to, new Map());
        pathFrequencies.set(path, (pathFrequencies.get(path) || 0) + 1);
    }

    computeUsualPaths(): UsualPaths {
        const usualPaths = new UsualPaths();
        for (const [from, destinationToPathFrequencies] of this.entries()) {
            for (const [to, pathFrequencies] of destinationToPathFrequencies.entries()) {
                const usualPath = findMostFrequentKeyInFrequencyMap(pathFrequencies);
                if (usualPath) {
                    usualPaths.setUsualPath(from, to, usualPath);
                }
            }
        }
        return usualPaths;
    }
}

// Starting location -> Current location -> Final destination -> Frequency
class DestinationFrequencyMatrix extends Map<LocationCode, Map<LocationCode, Map<LocationCode, number>>> {
    addDestinationFrequency(startingLocation: LocationCode, currentLocation: LocationCode, destination: LocationCode) {
        const currentLocationMap = getOrSet(this, startingLocation, new Map());
        const destinationFrequencies = getOrSet(currentLocationMap, currentLocation, new Map());
        destinationFrequencies.set(
            destination,
            (destinationFrequencies.get(destination) || 0) + 1
        );
    }

    computeUsualDestinations(): UsualDestinations {
        const usualDestinations = new UsualDestinations();
        for (const [startingLocation, currentLocationMap] of this.entries()) {
            for (const [currentLocation, destinationFrequencies] of currentLocationMap.entries()) {
                const usualDestination = findMostFrequentKeyInFrequencyMap(destinationFrequencies);
                if (usualDestination) {
                    usualDestinations.setUsualDestination(startingLocation, currentLocation, usualDestination);
                }
            }
        }
        return usualDestinations;
    }
}

async function main() {
    console.log("Fetching API constants...");
    const apiConstants = await getApiConstants();

    console.log("Fetched API constants. Fetching history summary...");
    const historySummary = await proxy.getHistorySummary();

    console.log(`Fetched history summary. Fetching and processing history for all ${Object.keys(historySummary.trains).length} TRNs...`);
    const allTimeDeltas = new TimeDeltaMap();
    const pathFrequencyMatrix = new PathFrequencyMatrix();
    const destinationFrequencyMatrix = new DestinationFrequencyMatrix();
    await pLimit(MAX_CONCURRENT_REQUESTS).map(
        Object.keys(historySummary.trains),
        async trn => {
            let latestTimestamp = new Date(0);
            let currentJourney: FullState[] = [];
            while (true) {
                const history = await proxy.getTrainHistory(trn, {
                    time: { from: new Date(latestTimestamp.getTime() + 1) },
                    limit: apiConstants.MAX_HISTORY_REQUEST_LIMIT,
                    active: true,
                });
                if (history.extract.length === 0) break;
                latestTimestamp = history.extract[history.extract.length - 1].date;
                for (const entry of history.extract) {
                    // Identify most recent/precise last seen
                    let fullState: FullState;
                    try {
                        fullState = await FullState.fromActiveTrainHistoryStatus(entry.status, entry.date);
                    } catch (error) {
                        // For example, unrecognized station
                        currentJourney = [];
                        continue;
                    }
                    // Add current state to journey
                    currentJourney.push(fullState);
                    // Analyze recent states for paths and destinations
                    if (currentJourney.length >= 2) {
                        const prevEntry = currentJourney[currentJourney.length - 2];
                        const prevLocationCode = prevEntry.locationCode;
                        if (prevEntry.date.getTime() >= fullState.date.getTime()) {
                            // Out of order entry. This shouldn't happen, but somehow does. Skip.
                            currentJourney.pop();
                            continue;
                        }
                        if (fullState.locationCode === prevLocationCode) {
                            if (fullState.state === prevEntry.state) {
                                // Duplicate entry; skip entirely
                                currentJourney.pop();
                                continue;
                            }
                        // Reset the current journey if the latest location is not adjacent to the last one
                        } else if (!isAdjacent(prevLocationCode,fullState.locationCode)) {
                            currentJourney = [];
                        // If the current station was seen recently, assume the previous location was a terminus
                        } else if (currentJourney.some(pastState =>
                                pastState !== fullState &&
                                pastState.stationCode === fullState.stationCode
                        )) {
                            const startingLocationCode = currentJourney[0].locationCode;
                            // Add to destination frequencies for all previous locations
                            for (const pastState of currentJourney) {
                                const recentLocationCode = pastState.locationCode;
                                destinationFrequencyMatrix.addDestinationFrequency(
                                    startingLocationCode,
                                    recentLocationCode,
                                    prevLocationCode
                                );
                            }
                            // Restart journey from the last location
                            currentJourney = [prevEntry, fullState];
                        }
                        if (fullState.state === "Arrived") {
                            // Compare with all previous states to build paths
                            for (let i = 0; i < currentJourney.length - 1; i++) {
                                const from = currentJourney[i];
                                const to = fullState;
                                const journeyLocationCodes = currentJourney
                                    .slice(i)
                                    .map(loc => loc.locationCode)
                                    // Collapse consecutive duplicates
                                    .filter((code, index, arr) => index === 0 || code !== arr[index - 1]);
                                if (journeyLocationCodes.length > 1) {
                                    // Remove `from` location, which is only kept for e.g. `Approaching-ABC_1->ABC_1`
                                    journeyLocationCodes.shift();
                                }
                                const pathKey = journeyLocationCodes.join("->");
                                // Add to path frequency matrix
                                if (from.locationCode !== journeyLocationCodes[journeyLocationCodes.length - 1]) {
                                    // Path only depends on location, not on state
                                    pathFrequencyMatrix.addPath(
                                        from.locationCode,
                                        to.stationCode,
                                        pathKey
                                    );
                                }
                                // Record time delta
                                allTimeDeltas.addDelta(
                                    `${from.key}->${pathKey}`,
                                    to.date.getTime() - from.date.getTime()
                                );
                            }
                        }
                    }
                }
                if (history.extract.length < apiConstants.MAX_HISTORY_REQUEST_LIMIT) {
                    // Avoid empty or tailing requests
                    break;
                }
            }
            console.log(`Processed all history for T${trn}`);
        }
    );
    console.log(`Processed all history; found ${allTimeDeltas.size} unique time delta keys. Computing median times...`);

    const medianPathTimes = allTimeDeltas.computeMedians();
    console.log("Computed median times. Computing usual paths...");
    const usualPaths = pathFrequencyMatrix.computeUsualPaths();
    console.log("Computed usual paths. Computing usual destinations...");
    const usualDestinations = destinationFrequencyMatrix.computeUsualDestinations();
    console.log("Computed usual destinations. Saving models...");

    await fs.mkdir('models', { recursive: true });
    await fs.writeFile(
        'models/medianPathTimes.json',
        JSON.stringify(medianPathTimes)
    );
    await fs.writeFile(
        'models/usualPaths.json',
        JSON.stringify(usualPaths)
    );
    await fs.writeFile(
        'models/usualDestinations.json',
        JSON.stringify(usualDestinations)
    );
    console.log("Saved models to files. Done.");
}

main().catch((error) => {
    console.error("Error in main execution:", error);
    process.exit(1);
});
