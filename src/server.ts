import "dotenv/config";
import { buildApplication } from "./app.js";

const context = await buildApplication({ logger: true });
let workerRunning = false;
const workerTimer = setInterval(() => {
  if (workerRunning) return;
  workerRunning = true;
  void context.engine.processPending(context.config.worker.batchSize)
    .catch((error) => context.app.log.error(error))
    .finally(() => { workerRunning = false; });
}, context.config.worker.intervalMs);
workerTimer.unref();

const shutdown = async () => {
  clearInterval(workerTimer);
  await context.app.close();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await context.app.listen({ host: context.config.host, port: context.config.port });
