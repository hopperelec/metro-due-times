import {LocationCode, PathKey, StationCode, TimeDeltaKey} from "./types";
import {getOrSet} from "./utils";

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
export class UsualPaths extends Map<StationCode, Map<StationCode, PathKey>> {
    setUsualPath(from: StationCode, to: StationCode, path: PathKey) {
        getOrSet(this, from, new Map()).set(to, path);
    }

    getUsualPath(from: StationCode, to: StationCode): PathKey {
        return this.get(from)?.get(to);
    }

    toJSON(): object {
        const obj: Record<StationCode, Record<StationCode, PathKey>> = {};
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
