import NETWORK_JSON from './pop-network.json';
import {LocationCode} from "./types";
import {locationsMatch} from "./utils";

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

export function shortestPath(from: LocationCode, to: LocationCode): LocationCode[] | null {
    const queue: LocationCode[] = [from];
    const visited: Set<LocationCode> = new Set([from]);
    const predecessors: Record<LocationCode, LocationCode> = {};

    while (queue.length > 0) {
        const current = queue.shift()!;
        const neighbors = network[current] || [];
        for (const neighbor of neighbors) {
            if (visited.has(neighbor)) continue;
            visited.add(neighbor);
            predecessors[neighbor] = current;
            if (locationsMatch(neighbor, to)) {
                const path: LocationCode[] = [];
                let step: LocationCode | undefined = neighbor;
                while (step && step !== from) {
                    path.unshift(step);
                    step = predecessors[step];
                }
                return path;
            }
            queue.push(neighbor);
        }
    }

    return null; // No path found
}
