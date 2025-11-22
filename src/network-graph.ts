import NETWORK_JSON from './pop-network.json';
import {LocationCode} from "./types";

const network: Record<LocationCode, Set<LocationCode>> = {};

for (const [from, toList] of Object.entries(NETWORK_JSON)) {
    network[from as LocationCode] = new Set(toList);
}

export default network;

export function isAdjacent(from: LocationCode, to: LocationCode): boolean {
    const adjacentLocations = network[from];
    if (!adjacentLocations) return false;
    return adjacentLocations.has(to);
}
