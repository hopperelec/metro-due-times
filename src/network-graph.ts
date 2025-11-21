import NETWORK_JSON from './pop-network.json';
import {LocationCode} from "./types";

export default NETWORK_JSON as Record<LocationCode, LocationCode[]>;

export function isAdjacent(from: LocationCode, to: LocationCode): boolean {
    const adjacentLocations = NETWORK_JSON[from];
    if (!adjacentLocations) return false;
    return adjacentLocations.includes(to);
}
