import {ActiveTrainState, PlatformNumber} from "metro-api-client";

export type StationCode = string;
export type LocationCode = StationCode | `${StationCode}_${PlatformNumber}`;
export type FullStateKey = `${ActiveTrainState}-${LocationCode}`;
export type PathKey = string; // "LocationCode->...->LocationCode"
export type TimeDeltaKey = string; // "FullStateKey->LocationCode->PathKey"