import {FullStateKey, LocationCode, PathKey, StationCode, TimeDeltaKey} from "./types";
import {getOrSet, toLocationCode} from "./utils";
import {
    ActiveTrainHistoryStatus,
    ActiveTrainState, ParsedLastSeen, parseLastSeen,
    parseTimesAPILocation,
    PlatformNumber,
    TimesApiData
} from "metro-api-client";
import {getStationCode} from "./proxy";

export class FullState {
    readonly state: ActiveTrainState;
    readonly stationCode: StationCode;
    readonly platform: PlatformNumber;
    readonly date: Date;

    constructor(state: ActiveTrainState, stationCode: StationCode, platform: PlatformNumber, date: Date) {
        this.state = state;
        this.stationCode = stationCode;
        this.platform = platform;
        this.date = date;
    }

    get locationCode(): LocationCode {
        return toLocationCode(this.stationCode, this.platform);
    }

    get key(): FullStateKey {
        return `${this.state}-${this.locationCode}`;
    }

    static async fromActiveTrainHistoryStatus(status: ActiveTrainHistoryStatus, heartbeatDate: Date): Promise<FullState> {
        const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

        async function formatTimesApi(event: TimesApiData['lastEvent']): Promise<FullState> {
            const {station, platform} = parseTimesAPILocation(event.location);
            let state = event.type.toLowerCase().replaceAll('_', ' ');
            state = state[0].toUpperCase() + state.slice(1); // Capitalize first letter
            return new FullState(
                state as ActiveTrainState,
                await getStationCode(station, platform),
                platform,
                event.time,
            );
        }

        async function formatGeoApi(parsedLastSeen: ParsedLastSeen, date: Date): Promise<FullState> {
            return new FullState(
                parsedLastSeen.state,
                await getStationCode(parsedLastSeen.station, parsedLastSeen.platform),
                parsedLastSeen.platform,
                date,
            );
        }

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
}

// TimeDeltaKey -> Median time delta (in ms)
export class MedianTimeDeltas extends Map<TimeDeltaKey, number> {
    toJSON(): object {
        return Object.fromEntries(this);
    }

    static fromJSON(json: any): MedianTimeDeltas {
        if (json === null) throw new Error("MedianTimeDeltas cannot be null");
        if (typeof json !== "object") throw new Error(`Expected MedianTimeDeltas to be an object, got ${typeof json}`);
        if (Array.isArray(json)) throw new Error("Expected MedianTimeDeltas to be a record, got an array");
        const medianTimeDeltas = new MedianTimeDeltas();
        for (const [key, value] of Object.entries(json)) {
            if (typeof key !== "string") {
                throw new Error(`Expected key to be a string, got ${typeof key}`);
            }
            if (typeof value !== "number") {
                throw new Error(`Expected value to be a number, got ${typeof value}`);
            }
            medianTimeDeltas.set(key, value);
        }
        return medianTimeDeltas;
    }
}

// Current location -> Destination -> Usual path
export class UsualPaths extends Map<LocationCode, Map<StationCode, PathKey>> {
    setUsualPath(from: LocationCode, to: StationCode, path: PathKey) {
        getOrSet(this, from, new Map()).set(to, path);
    }

    getUsualPathKey(from: LocationCode, to: StationCode): PathKey {
        return this.get(from)?.get(to);
    }

    getUsualPath(from: LocationCode, to: StationCode): LocationCode[] {
        return this.getUsualPathKey(from, to)?.split('->');
    }

    toJSON(): object {
        const obj: Record<LocationCode, Record<StationCode, PathKey>> = {};
        for (const [from, toMap] of this.entries()) {
            obj[from] = {};
            for (const [to, path] of toMap.entries()) {
                obj[from][to] = path;
            }
        }
        return obj;
    }

    static fromJSON(json: any): UsualPaths {
        if (json === null) throw new Error("UsualPaths cannot be null");
        if (typeof json !== "object") throw new Error(`Expected UsualPaths to be an object, got ${typeof json}`);
        if (Array.isArray(json)) throw new Error("Expected UsualPaths to be a record, got an array");
        const usualPaths = new UsualPaths();
        for (const [from, toMap] of Object.entries(json)) {
            if (typeof from !== "string") {
                throw new Error(`Expected from to be a string, got ${typeof from}`);
            }
            if (toMap === null) {
                throw new Error(`UsualPaths[${from}] cannot be null`);
            }
            if (typeof toMap !== "object") {
                throw new Error(`Expected UsualPaths[${from}] to be an object, got ${typeof toMap}`);
            }
            if (Array.isArray(toMap)) {
                throw new Error(`Expected UsualPaths[${from}] to be a record, got an array`);
            }
            for (const [to, path] of Object.entries(toMap)) {
                if (typeof to !== "string") {
                    throw new Error(`Expected to to be a string, got ${typeof to}`);
                }
                if (typeof path !== "string") {
                    throw new Error(`Expected path to be a string, got ${typeof path}`);
                }
                usualPaths.setUsualPath(from, to, path);
            }
        }
        return usualPaths;
    }
}

// Starting location -> Current location -> Usual final destination
export class UsualDestinations extends Map<LocationCode, Map<LocationCode, LocationCode>> {
    setUsualDestination(startingLocation: LocationCode, currentLocation: LocationCode, destination: LocationCode) {
        getOrSet(this, startingLocation, new Map()).set(currentLocation, destination);
    }

    getUsualDestination(startingLocation: LocationCode, currentLocation: LocationCode): LocationCode {
        return this.get(startingLocation)?.get(currentLocation);
    }

    toJSON(): object {
        const obj: Record<LocationCode, Record<LocationCode, LocationCode>> = {};
        for (const [startingLocation, currentToDestination] of this.entries()) {
            obj[startingLocation] = {};
            for (const [currentLocation, destination] of currentToDestination.entries()) {
                obj[startingLocation][currentLocation] = destination;
            }
        }
        return obj;
    }

    static fromJSON(json: any): UsualDestinations {
        if (json === null) throw new Error("UsualDestinations cannot be null");
        if (typeof json !== "object") throw new Error(`Expected UsualDestinations to be an object, got ${typeof json}`);
        if (Array.isArray(json)) throw new Error("Expected UsualDestinations to be a record, got an array");
        const usualDestinations = new UsualDestinations();
        for (const [startingLocation, currentToDestination] of Object.entries(json)) {
            if (typeof startingLocation !== "string") {
                throw new Error(`Expected startingLocation to be a string, got ${typeof startingLocation}`);
            }
            if (currentToDestination === null) {
                throw new Error(`UsualDestinations[${startingLocation}] cannot be null`);
            }
            if (typeof currentToDestination !== "object") {
                throw new Error(`Expected UsualDestinations[${startingLocation}] to be an object, got ${typeof currentToDestination}`);
            }
            if (Array.isArray(currentToDestination)) {
                throw new Error(`Expected UsualDestinations[${startingLocation}] to be a record, got an array`);
            }
            for (const [currentLocation, destination] of Object.entries(currentToDestination)) {
                if (typeof currentLocation !== "string") {
                    throw new Error(`Expected currentLocation to be a string, got ${typeof currentLocation}`);
                }
                if (typeof destination !== "string") {
                    throw new Error(`Expected destination to be a string, got ${typeof destination}`);
                }
                usualDestinations.setUsualDestination(startingLocation, currentLocation, destination);
            }
        }
        return usualDestinations;
    }
}
