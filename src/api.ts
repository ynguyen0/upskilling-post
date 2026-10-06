import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { salonWorkflow, salonCommand, getSalon } from "./workflows";
import { seedClients, seedOpenings, DEMO_NOW } from "./seed";
import type { Command } from "./types";
const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(process.cwd(), "public")));
const demo = process.env.DEMO_MODE !== "false";
const workflowId =
  process.env.SALON_WORKFLOW_ID ??
  (demo ? "juniper-salon-demo-v1" : "juniper-salon-live-v1");
let clientPromise: Promise<Client> | undefined;
async function getClient() {
  if (!clientPromise)
    clientPromise = Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    }).then((connection) => new Client({ connection, namespace: "default" }));
  try {
    return await clientPromise;
  } catch (e) {
    clientPromise = undefined;
    throw e;
  }
}
let ready: Promise<void> | undefined;
async function handle() {
  const client = await getClient();
  ready ??= (async () => {
    const now = demo ? DEMO_NOW : Date.now();
    try {
      await client.workflow.start(salonWorkflow, {
        workflowId,
        taskQueue: "juniper-salon",
        args: [
          {
            demo,
            initialNow: now,
            clients: demo ? seedClients(now) : [],
            openings: demo ? seedOpenings(now) : [],
          },
        ],
      });
    } catch (e) {
      if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
    }
  })();
  try {
    await ready;
  } catch (e) {
    ready = undefined;
    throw e;
  }
  return client.workflow.getHandle<typeof salonWorkflow>(workflowId);
}
app.get("/api/state", async (_req, res) => {
  const workflow = await handle();
  const state = await workflow.query(getSalon);
  res.json({ ...state, now: Date.now() + state.clockOffset, workflowId });
});
function validCommand(c: any): c is Command {
  if (!c || typeof c !== "object") return false;
  const str = (x: any) =>
    typeof x === "string" && x.length > 0 && x.length <= 1000;
  switch (c.type) {
    case "advance":
      return typeof c.minutes === "number";
    case "createOpening":
      return (
        str(c.id) &&
        str(c.service) &&
        str(c.stylist) &&
        typeof c.startsAt === "number" &&
        typeof c.duration === "number"
      );
    case "start":
      return (
        str(c.openingId) &&
        Array.isArray(c.candidateIds) &&
        c.candidateIds.length <= 200 &&
        c.candidateIds.every(str)
      );
    case "reply":
      return str(c.openingId) && str(c.offerId) && str(c.text);
    case "close":
    case "square":
      return str(c.openingId);
    case "resolve":
      return str(c.alertId);
    case "removeClient":
      return str(c.clientId);
    case "addClient":
      return (
        c.client &&
        ["id", "name", "mobile", "service", "stylist", "availability"].every(
          (k) => str(c.client[k]),
        ) &&
        ["Haircut", "Color", "Blowout"].includes(c.client.service) &&
        ["Any stylist", "Carla", "Lena"].includes(c.client.stylist) &&
        /^\+?[\d\s()\-]{10,20}$/.test(c.client.mobile)
      );
    default:
      return false;
  }
}
app.post("/api/command", async (req, res) => {
  if (!validCommand(req.body)) {
    res.status(400).json({ error: "Please check the form fields." });
    return;
  }
  const workflow = await handle();
  // Browser retains the key on a network retry; Temporal deduplicates Update IDs.
  const updateId = req.header("Idempotency-Key") || randomUUID();
  const result = await workflow.executeUpdate(salonCommand, {
    args: [req.body],
    updateId,
  });
  res.status(result.ok ? 200 : 409).json(result);
});
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res
    .status(503)
    .json({
      error:
        "The salon service is unavailable. Your saved progress remains in Temporal. Retry when the worker is connected.",
    });
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, "127.0.0.1", () =>
  console.log(`Juniper Salon: http://localhost:${port}`),
);
