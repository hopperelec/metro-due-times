import proxy from "./proxy";

const PREDICTION_WINDOW = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

async function main() {
    let connected = false;
    proxy.streamTrainsHistory({
        onNewHistoryEntries: async (payload) => {
            if (!connected) {
                connected = true;
                console.log("Connected to train history stream");
            }
            for (const [trn, entry] of Object.entries(payload.trains)) {
                // TODO: Predict due times
            }
        }
    });
}

main().catch((error) => {
    console.error("Error in main execution:", error);
    process.exit(1);
});
