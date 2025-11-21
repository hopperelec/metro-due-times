import {ApiConstants, MetroApiClient, PlatformNumber} from "metro-api-client";
import {configDotenv} from "dotenv";
import {StationCode} from "./types";

configDotenv();
const PROXY_BASE_URL = process.env.PROXY_BASE_URL;
if (!PROXY_BASE_URL) {
    throw new Error("PROXY_BASE_URL is not defined in environment variables");
}

const proxy = new MetroApiClient(PROXY_BASE_URL);

export default proxy;

export let apiConstants: ApiConstants | null = null;
let stationToCode: Record<string, StationCode> | null = null;

export async function reloadApiConstants() {
    apiConstants = await proxy.getConstants();
    stationToCode = {};
    for (const [code, name] of Object.entries(apiConstants.LOCATION_ABBREVIATIONS)) {
        stationToCode[name] = code;
    }
}

export async function getStationCode(station: string, platform: PlatformNumber): Promise<StationCode> {
    if (!stationToCode) await reloadApiConstants();
    if (station === "Monument") return platform <= 2 ? "MTS" : "MTW";
    const code = stationToCode[station];
    if (code) return code;
    throw new Error(`Unrecognised station: ${station}`);
}
