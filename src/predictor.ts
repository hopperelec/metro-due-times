import {readFile} from "node:fs/promises";
import {FullState, MedianTimeDeltas, UsualDestinations, UsualPaths} from "./models";
import {DayTimetable, FullTrainsResponse, TrainTimetable} from "metro-api-client";
import {LocationCode, StationCode} from "./types";
import {locationsMatch, parseLocation, toSecondsSinceMidnight} from "./utils";
import {shortestPath} from "./network-graph";
import proxy, {getApiConstants} from "./proxy";

export const PREDICTION_WINDOW = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
export const TIMETABLE_THRESHOLD = 15 * 60;  // 15 minutes in seconds

export interface ArrivalPrediction {
    locationCode: LocationCode;
    time: Date;
}

export class Predictor {
    private medianPathTimes: MedianTimeDeltas;
    private usualPaths: UsualPaths;
    private usualDestinations: UsualDestinations;

    constructor(
        medianPathTimes: MedianTimeDeltas,
        usualPaths: UsualPaths,
        usualDestinations: UsualDestinations
    ) {
        this.medianPathTimes = medianPathTimes;
        this.usualPaths = usualPaths;
        this.usualDestinations = usualDestinations;
    }

    predictNextArrivals(
        heartbeatDate: Date, // used to avoid predicting times in the past, and to enforce PREDICTION_WINDOW
        initialState: FullState,
        startingLocation: LocationCode = null,
        destination: StationCode = null,
        timetable: TrainTimetable = null
    ): ArrivalPrediction[] {
        const initialLocation = `${initialState.stationCode}_${initialState.platform}`;
        if (startingLocation === null) {
            startingLocation = initialLocation;
        }

        if (destination === null) {
            if (timetable) {
                // Find the nearest corresponding timetable entry, then use its destination
                const useArrival = initialState.state === "Approaching" || initialState.state === "Arrived";
                const secondsSinceMidnight = toSecondsSinceMidnight(initialState.date);
                let smallestTimeDiff = TIMETABLE_THRESHOLD;
                for (const entry of timetable) {
                    if (entry.departureTime !== undefined && locationsMatch(entry.location, initialLocation)) {
                        const entryTime = useArrival && entry.arrivalTime ? entry.arrivalTime : entry.departureTime;
                        const timeDiff = Math.abs(entryTime - secondsSinceMidnight);
                        if (timeDiff < smallestTimeDiff) {
                            smallestTimeDiff = timeDiff;
                            destination = parseLocation(entry.destination).station; // ignore platform for destination
                            if (destination === "MTN") destination = "MTS";
                            else if (destination === "MTE") destination = "MTW";
                        }
                    }
                }
            }
            if (!destination) {
                destination = this.usualDestinations.getUsualDestination(startingLocation, initialLocation);
            }
            if (!destination) {
                throw new Error(`No destination found for starting location ${startingLocation} and current location ${initialLocation}`);
            }
        }

        const path = this.usualPaths.getUsualPath(initialLocation, destination) || shortestPath(initialLocation, destination);
        if (!path) throw new Error(`No path found from ${initialLocation} to ${destination}`);

        const predictions: ArrivalPrediction[] = [];
        const pathed = [];
        let currentStateKey = `${initialState.state}-${initialLocation}`; // Should stay as early as possible to make times more precise
        let bufferTime = 0;
        for (const nextLocation of path) {
            let medianTimeDelta = this.medianPathTimes.get([currentStateKey, ...pathed, nextLocation].join("->"));
            foundDelta: if (medianTimeDelta === undefined) {
                // See if any of the already pathed locations can help
                for (let i = pathed.length - 1; i >= 0; i--) {
                    currentStateKey = `Arrived-${pathed[i]}`;
                    medianTimeDelta = this.medianPathTimes.get([currentStateKey, ...pathed.slice(i + 1), nextLocation].join("->"));
                    if (medianTimeDelta !== undefined) {
                        break foundDelta;
                    }
                }
                return predictions;
            }
            let time = new Date(initialState.date.getTime() + bufferTime + medianTimeDelta);
            if (time.getTime() < heartbeatDate.getTime()) {
                bufferTime += heartbeatDate.getTime() - time.getTime();
                time = new Date(heartbeatDate);
            }
            if (time.getTime() - heartbeatDate.getTime() > PREDICTION_WINDOW) {
                return predictions;
            }
            pathed.push(nextLocation);
            predictions.push({
                locationCode: nextLocation,
                time,
            });
        }

        const lastLocation = path[path.length - 1];
        const {station, platform} = parseLocation(lastLocation);
        try {
            predictions.push(
                ...this.predictNextArrivals(
                    heartbeatDate,
                    new FullState(
                        "Arrived",
                        station,
                        platform,
                        predictions[predictions.length - 1].time
                    ),
                    lastLocation,
                    null, // destination will change
                    timetable
                )
            );
        } catch (e) {
            // No further path
        }
        return predictions;
    }
}

async function staticDemo(predictor: Predictor, timetable: DayTimetable) {
    const date = new Date(2025, 10, 21, 16, 30, 30); // Nov 23, 2025, 16:30:30
    console.log(predictor.predictNextArrivals(
        date,
        new FullState("Departed", "HOW", 2, date),
        "SSS_2",
        "SJM",
        timetable.trains["121"]
    ));
}

async function realtimeDemo(predictor: Predictor, timetable: DayTimetable) {
    console.log("Fetching current train states...");
    const currentStates = await proxy.getTrains() as FullTrainsResponse;

    console.log("Fetching recent locations...");
    const recentLocations: Record<string, LocationCode[]> = {};
    for (const trn of Object.keys(currentStates.trains)) {
        recentLocations[trn] = [];
        // TODO: Paginate
        const history = await proxy.getTrainHistory(trn, {
            limit: (await getApiConstants()).MAX_HISTORY_REQUEST_LIMIT,
            active: true,
        });
        for (const entry of history.extract.toReversed()) {
            const {locationCode} = await FullState.fromActiveTrainHistoryStatus(entry.status, entry.date);
            if (recentLocations[trn].includes(locationCode)) {
                break;
            } else {
                recentLocations[trn].unshift(locationCode);
            }
        }
    }

    console.log("Predicting arrivals...");
    const trainsPredictions: Record<string, ArrivalPrediction[]> = {};
    for (const [trn,state] of Object.entries(currentStates.trains)) {
        try {
            const fullState = await FullState.fromActiveTrainHistoryStatus(state.status, currentStates.lastChecked);
            trainsPredictions[trn] = predictor.predictNextArrivals(
                currentStates.lastChecked,
                fullState,
                recentLocations[trn][0] || fullState.locationCode,
                null, // TODO: destination
                timetable.trains[trn] || null
            );
        } catch (e) {
            console.warn(`Could not predict next arrivals for train T${trn}: ${e.message}`);
        }
    }

    // Example usage: Find next trains due at a specific platform
    // TODO: The results aren't as expected, need to debug
    const targetLocation: LocationCode = "HDR_2";
    const arrivalsAtTarget: {trn: string; time: Date}[] = [];
    for (const [trn, trainPredictions] of Object.entries(trainsPredictions)) {
        for (const prediction of trainPredictions) {
            if (prediction.locationCode === targetLocation) {
                arrivalsAtTarget.push({trn, time: prediction.time});
                break;
            }
        }
    }
    arrivalsAtTarget.sort((a, b) => a.time.getTime() - b.time.getTime());
    console.log(`Next arrivals at ${targetLocation}:`);
    for (const arrival of arrivalsAtTarget.slice(0, 5)) {
        console.log(`Train T${arrival.trn} at ${arrival.time.getHours().toString().padStart(2, '0')}:${arrival.time.getMinutes().toString().padStart(2, '0')}`);
    }
}

async function main() {
    console.log("Loading models...");
    const [
        medianPathTimes,
        usualPaths,
        usualDestinations,
        timetable
    ] = await Promise.all([
        readFile("models/medianPathTimes.json", "utf-8").then(JSON.parse).then(MedianTimeDeltas.fromJSON),
        readFile("models/usualPaths.json", "utf-8").then(JSON.parse).then(UsualPaths.fromJSON),
        readFile("models/usualDestinations.json", "utf-8").then(JSON.parse).then(UsualDestinations.fromJSON),
        proxy.getTimetable({date: new Date(2025, 10, 21)})
    ]);
    const predictor = new Predictor(medianPathTimes, usualPaths, usualDestinations);

    console.log("Running static demo...");
    await staticDemo(predictor, timetable);

    console.log("Running realtime demo...");
    await realtimeDemo(predictor, timetable);
}

main().catch((error) => {
    console.error("Error in predictor:", error);
    process.exit(1);
});
