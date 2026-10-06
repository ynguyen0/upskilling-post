import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Connection, Client } from "@temporalio/client";
import {
  NativeConnection,
  Worker,
  Runtime,
  DefaultLogger,
} from "@temporalio/worker";
import { salonWorkflow, salonCommand, getSalon } from "../src/workflows";
import { seedClients, seedOpenings, DEMO_NOW } from "../src/seed";
import {
  addBusinessMinutes,
  centralTime,
  nextBusinessTime,
} from "../src/calendar";
import type { Message, Opening, SalonState, Command } from "../src/types";
Runtime.install({ logger: new DefaultLogger("ERROR") });
const at = (iso: string) => Date.parse(iso);
test("Central business calendar carries remaining time overnight, skips Sunday, and observes DST", () => {
  assert.equal(
    addBusinessMinutes(at("2026-10-07T23:45:00Z"), 60),
    at("2026-10-08T14:45:00Z"),
  );
  assert.equal(
    nextBusinessTime(at("2026-10-11T02:00:00Z")),
    at("2026-10-12T14:00:00Z"),
  );
  assert.equal(
    nextBusinessTime(at("2026-03-08T02:00:00Z")),
    at("2026-03-09T14:00:00Z"),
  );
  assert.equal(centralTime(2026, 10, 2, 9), at("2026-11-02T15:00:00Z"));
});

test(
  "real Temporal workflows enforce Juniper rules",
  { timeout: 90000 },
  async (t) => {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    });
    const native = await NativeConnection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    });
    const client = new Client({ connection });
    const queue = "juniper-test-" + randomUUID();
    const handles: ReturnType<
      typeof client.workflow.getHandle<typeof salonWorkflow>
    >[] = [];
    const delivered = new Map<string, number>();
    const activity = async (m: Message, workspace: string) => {
      const key = workspace + "/" + m.id;
      delivered.set(key, (delivered.get(key) || 0) + 1);
      return { delivered: !m.failDelivery };
    };
    const makeWorker = () =>
      Worker.create({
        connection: native,
        taskQueue: queue,
        workflowsPath: require.resolve("../src/workflows"),
        activities: { deliverMessage: activity },
      });
    const start = async (
      now = DEMO_NOW,
      openings = seedOpenings(now),
      clients = seedClients(now),
    ) => {
      const h = await client.workflow.start(salonWorkflow, {
        workflowId: "test-" + randomUUID(),
        taskQueue: queue,
        args: [{ demo: true, initialNow: now, clients, openings }],
      });
      handles.push(h);
      return h;
    };
    const state = (h: (typeof handles)[number]) => h.query(getSalon);
    const cmd = (h: (typeof handles)[number], command: Command) =>
      h.executeUpdate(salonCommand, { args: [command] });
    const until = async (
      h: (typeof handles)[number],
      predicate: (s: SalonState) => boolean,
    ) => {
      for (let i = 0; i < 100; i++) {
        const s = await state(h);
        if (predicate(s)) return s;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("State did not converge");
    };
    let recovery: (typeof handles)[number];
    let savedOffer: string;
    let savedDeadline: number;
    let recoveryDeliveryCount: number;
    try {
      await (
        await makeWorker()
      ).runUntil(async () => {
        await t.test(
          "review, ambiguous reply, timeout, late YES, timely YES, duplicate YES and Square",
          async () => {
            const h = await start();
            await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["sophie", "mia", "ava"],
            });
            let s = await until(
              h,
              (s) => s.openings[0].offers[0]?.status === "waiting",
            );
            let o = s.openings[0],
              offer = o.offers[0];
            assert.equal(offer.clientId, "ava");
            await cmd(h, {
              type: "reply",
              openingId: o.id,
              offerId: offer.id,
              text: "Can I come later?",
            });
            s = await state(h);
            assert.equal(s.alerts[0].kind, "reply");
            assert.equal(s.openings[0].offers[0].deadline, offer.deadline);
            await cmd(h, { type: "advance", minutes: 15 });
            s = await until(
              h,
              (s) => s.openings[0].offers[1]?.status === "waiting",
            );
            assert.equal(s.openings[0].offers[1].clientId, "mia");
            await cmd(h, {
              type: "reply",
              openingId: o.id,
              offerId: offer.id,
              text: "YES",
            });
            s = await state(h);
            assert.equal(s.openings[0].phase, "offering");
            const next = s.openings[0].offers[1];
            await cmd(h, {
              type: "reply",
              openingId: o.id,
              offerId: next.id,
              text: "YES",
            });
            await cmd(h, {
              type: "reply",
              openingId: o.id,
              offerId: next.id,
              text: "YES",
            });
            s = await state(h);
            assert.equal(s.openings[0].confirmedClientId, "mia");
            assert.equal(s.clients.find((c) => c.id === "mia")?.active, false);
            assert.equal(s.clients.find((c) => c.id === "ava")?.active, true);
            await cmd(h, { type: "square", openingId: o.id });
            assert.equal((await state(h)).openings[0].squareUpdated, true);
            await cmd(h, { type: "close", openingId: o.id });
            s = await state(h);
            assert.equal(s.openings[0].phase, "filled");
            assert(s.alerts.some((a) => a.kind === "conflict"));
          },
        );
        await t.test(
          "competing openings never offer the same client together",
          async () => {
            const openings = seedOpenings(DEMO_NOW);
            openings.push({
              ...openings[0],
              id: "second",
              startsAt: DEMO_NOW + 5 * 3600000,
              offers: [],
              history: [],
            });
            const h = await start(DEMO_NOW, openings);
            await Promise.all(
              openings.map((o) =>
                cmd(h, {
                  type: "start",
                  openingId: o.id,
                  candidateIds: ["ava", "mia"],
                }),
              ),
            );
            let s = await until(h, (s) =>
              s.openings.every((o) =>
                o.offers.some((x) => x.status === "waiting"),
              ),
            );
            assert.equal(
              new Set(
                s.openings.flatMap((o) => o.offers.map((x) => x.clientId)),
              ).size,
              2,
            );
            const o = s.openings[0],
              offer = o.offers[0];
            await Promise.all([
              cmd(h, {
                type: "reply",
                openingId: o.id,
                offerId: offer.id,
                text: "YES",
              }),
              cmd(h, { type: "close", openingId: o.id }),
            ]);
            s = await state(h);
            assert(["filled", "closed"].includes(s.openings[0].phase));
            assert.equal(
              s.openings[0].offers.filter((x) => x.status === "accepted")
                .length,
              s.openings[0].phase === "filled" ? 1 : 0,
            );
          },
        );
        await t.test(
          "failed delivery alerts staff and moves on; NO stays waitlisted; STOP removes",
          async () => {
            const h = await start();
            await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ruby"],
            });
            let s = await until(h, (s) => s.openings[0].phase === "unfilled");
            assert.equal(s.openings[0].offers[0].status, "failed");
            assert.equal(s.alerts[0].kind, "delivery");
            await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ava", "mia"],
            });
            s = await until(
              h,
              (s) => s.openings[0].offers[1]?.status === "waiting",
            );
            await cmd(h, {
              type: "reply",
              openingId: "opening-welcome",
              offerId: s.openings[0].offers[1].id,
              text: "NO",
            });
            s = await until(
              h,
              (s) => s.openings[0].offers[2]?.status === "waiting",
            );
            assert.equal(s.clients.find((c) => c.id === "ava")?.active, true);
            await cmd(h, {
              type: "reply",
              openingId: "opening-welcome",
              offerId: s.openings[0].offers[2].id,
              text: "STOP",
            });
            s = await state(h);
            assert.equal(s.clients.find((c) => c.id === "mia")?.active, false);
            assert.equal(s.openings[0].phase, "unfilled");
          },
        );
        await t.test(
          "late-night cancellation sends nothing until business morning",
          async () => {
            const night = at("2026-10-07T02:00:00Z");
            const openings = seedOpenings(night);
            openings[0].startsAt = at("2026-10-07T19:00:00Z");
            const h = await start(night, openings);
            await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ava"],
            });
            let s = await state(h);
            assert.equal(s.openings[0].phase, "queued");
            assert.equal(s.messages.length, 0);
            await cmd(h, { type: "advance", minutes: 720 });
            s = await until(
              h,
              (s) => s.openings[0].offers[0]?.status === "waiting",
            );
            assert.equal(
              s.openings[0].offers[0].deadline -
                s.openings[0].offers[0].createdAt,
              15 * 60000,
            );
          },
        );
        await t.test(
          "tomorrow offer carries remaining hour overnight",
          async () => {
            const evening = at("2026-10-06T23:45:00Z"),
              openings = seedOpenings(evening);
            openings[0].startsAt = at("2026-10-07T20:00:00Z");
            const h = await start(evening, openings);
            await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ava"],
            });
            const s = await until(
              h,
              (s) => s.openings[0].offers[0]?.status === "waiting",
            );
            assert(
              Math.abs(
                s.openings[0].offers[0].deadline - at("2026-10-07T14:45:00Z"),
              ) < 3000,
            );
          },
        );
        await t.test(
          "real durable timer fires at one-hour cutoff without clock commands",
          async () => {
            const startTime = DEMO_NOW,
              openings = seedOpenings(startTime);
            openings[0].startsAt = startTime + 3600000 + 2000;
            const h = await start(startTime, openings);
            await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ava"],
            });
            let s = await until(
              h,
              (s) => s.openings[0].offers[0]?.status === "waiting",
            );
            const offer = s.openings[0].offers[0];
            assert.equal(offer.deadline, openings[0].startsAt - 3600000);
            s = await until(h, (s) => s.openings[0].phase === "unfilled");
            assert.equal(s.openings[0].offers[0].status, "timed_out");
            await cmd(h, {
              type: "reply",
              openingId: "opening-welcome",
              offerId: offer.id,
              text: "YES",
            });
            assert.equal((await state(h)).openings[0].phase, "unfilled");
          },
        );
        await t.test(
          "staff cancellation invalidates active offer and sends apology",
          async () => {
            const h = await start();
            await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ava"],
            });
            const s = await until(
              h,
              (s) => s.openings[0].offers[0]?.status === "waiting",
            );
            await cmd(h, { type: "close", openingId: "opening-welcome" });
            await cmd(h, {
              type: "reply",
              openingId: "opening-welcome",
              offerId: s.openings[0].offers[0].id,
              text: "YES",
            });
            const after = await state(h);
            assert.equal(after.openings[0].phase, "closed");
            assert(
              after.messages.some((m) =>
                m.text.startsWith("Sorry, this opening"),
              ),
            );
          },
        );
        await t.test(
          "failed first recipient advances automatically to the next reviewed client",
          async () => {
            const clients = seedClients(DEMO_NOW);
            clients[0].deliveryFails = true;
            const h = await start(DEMO_NOW, seedOpenings(DEMO_NOW), clients);
            await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ava", "mia"],
            });
            const s = await until(
              h,
              (s) => s.openings[0].offers[1]?.status === "waiting",
            );
            assert.equal(s.openings[0].offers[0].status, "failed");
            assert.equal(s.openings[0].offers[1].clientId, "mia");
            assert.equal(s.alerts[0].kind, "delivery");
          },
        );
        await t.test(
          "duplicate Update ID produces one command effect; phone formatting cannot duplicate a client",
          async () => {
            const h = await start();
            const updateId = randomUUID();
            const args: [Command] = [{ type: "advance", minutes: 15 }];
            await h.executeUpdate(salonCommand, { args, updateId });
            await h.executeUpdate(salonCommand, { args, updateId });
            const s = await state(h);
            assert(Math.abs(s.now - DEMO_NOW - 15 * 60000) < 3000);
            const result = await cmd(h, {
              type: "addClient",
              client: {
                ...s.clients[0],
                id: "duplicate",
                mobile: "3125550101",
              },
            });
            assert.equal(result.ok, false);
          },
        );
        await t.test(
          "reopening an exhausted queue cannot overlap a new active slot",
          async () => {
            const openings = seedOpenings(DEMO_NOW);
            openings[0].phase = "unfilled";
            openings.push({
              ...openings[0],
              id: "replacement",
              phase: "review",
              offers: [],
              history: [],
            });
            const h = await start(DEMO_NOW, openings);
            const blocked = await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ava"],
            });
            assert.equal(blocked.ok, false);
            await cmd(h, { type: "close", openingId: "replacement" });
            const allowed = await cmd(h, {
              type: "start",
              openingId: "opening-welcome",
              candidateIds: ["ava"],
            });
            assert.equal(allowed.ok, true);
          },
        );
        recovery = await start();
        await cmd(recovery, {
          type: "start",
          openingId: "opening-welcome",
          candidateIds: ["ava", "mia"],
        });
        const s = await until(
          recovery,
          (s) => s.openings[0].offers[0]?.status === "waiting",
        );
        savedOffer = s.openings[0].offers[0].id;
        savedDeadline = s.openings[0].offers[0].deadline;
        recoveryDeliveryCount = delivered.get(
          recovery.workflowId + "/" + s.messages[0].id,
        )!;
      });
      await (
        await makeWorker()
      ).runUntil(async () => {
        await t.test(
          "worker restart replays existing offer without duplicate message",
          async () => {
            const s = await state(recovery);
            assert.equal(s.openings[0].offers[0].id, savedOffer);
            assert.equal(s.openings[0].offers[0].deadline, savedDeadline);
            assert.equal(s.messages.length, 1);
            assert.equal(
              delivered.get(recovery.workflowId + "/" + s.messages[0].id),
              recoveryDeliveryCount,
            );
            await cmd(recovery, {
              type: "reply",
              openingId: "opening-welcome",
              offerId: savedOffer,
              text: "YES",
            });
            assert.equal((await state(recovery)).openings[0].phase, "filled");
          },
        );
      });
    } finally {
      await Promise.all(handles.map((h) => h.terminate("Test complete")));
      await native.close();
      await connection.close();
    }
  },
);
