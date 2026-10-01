import "dotenv/config";
import { workerTick } from "../src/server/worker";

// standalone worker for deployments that run the web app with DISABLE_INPROCESS_WORKER=true
const interval = Number(process.env.WORKER_INTERVAL_MS) || 15_000;
console.log(`worker: ticking every ${interval}ms`);
const loop = async () => {
  await workerTick();
  setTimeout(loop, interval);
};
loop();
