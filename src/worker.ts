import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: "juniper-salon",
    workflowsPath: require.resolve("./workflows"),
    activities,
  });
  console.log("Juniper Worker is ready.");
  await worker.run();
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
