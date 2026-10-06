import {
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  SalonState,
  SalonInput,
  Command,
  CommandResult,
  Opening,
  Offer,
} from "./types";
import {
  addBusinessMinutes,
  centralLabel,
  nextBusinessTime,
  sameCentralDay,
} from "./calendar";
export const getSalon = defineQuery<SalonState>("getSalon");
export const salonCommand = defineUpdate<CommandResult, [Command]>(
  "salonCommand",
);
const { deliverMessage } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "5 seconds",
    maximumAttempts: 3,
  },
});

// One entity Workflow per salon is the atomic owner of all openings and clients.
// Synchronous Update handlers reserve/accept without an await between check and write.
// That serializes competing claims and prevents cross-opening client offers.
export async function salonWorkflow(input: SalonInput): Promise<void> {
  let offset =
    input.demo && input.initialNow ? input.initialNow - Date.now() : 0;
  let seq = 0,
    dirty = true;
  const now = () => Date.now() + offset;
  const state: SalonState = {
    demo: input.demo,
    now: now(),
    clockOffset: offset,
    clients: input.clients,
    openings: input.openings ?? [],
    messages: [],
    alerts: [],
    revision: 0,
  };
  const normalizePhone = (phone: string) => {
    const digits = phone.replace(/\D/g, "");
    return digits.length === 10 ? "1" + digits : digits;
  };
  const id = () => `event-${++seq}`;
  const current = (o: Opening) =>
    o.offers.find((x) => x.status === "waiting" || x.status === "sending");
  const history = (o: Opening, text: string) =>
    o.history.push({ at: now(), text });
  function alert(
    o: Opening,
    kind: "reply" | "delivery" | "conflict",
    text: string,
    offerId?: string,
  ) {
    state.alerts.push({
      id: id(),
      openingId: o.id,
      kind,
      text,
      offerId,
      resolved: false,
      at: now(),
    });
  }
  function message(
    o: Opening,
    clientId: string,
    text: string,
    offer?: Offer,
    failDelivery = false,
  ) {
    state.messages.push({
      id: id(),
      openingId: o.id,
      clientId,
      offerId: offer?.id,
      direction: "out",
      text,
      at: now(),
      status: "pending",
      failDelivery,
    });
    dirty = true;
  }
  function endOffer(
    o: Opening,
    offer: Offer,
    status: Offer["status"],
    note: string,
  ) {
    offer.status = status;
    history(o, note);
    o.phase = "queued";
  }
  function tick() {
    const t = now();
    // Expire every slot before selecting any new client.
    for (const o of state.openings) {
      const offer = current(o);
      if (offer && t >= offer.deadline)
        endOffer(
          o,
          offer,
          "timed_out",
          "Response deadline passed. Client stays on the waitlist.",
        );
      if (
        ["review", "queued", "offering"].includes(o.phase) &&
        t >= o.startsAt - 3_600_000
      ) {
        o.phase = "unfilled";
        history(o, "Outreach ended at the one-hour arrival cutoff.");
      }
    }
    const busy = new Set(
      state.openings.flatMap((o) =>
        o.offers
          .filter((x) => ["sending", "waiting"].includes(x.status))
          .map((x) => x.clientId),
      ),
    );
    for (const o of state.openings) {
      if (o.phase !== "queued" || current(o)) continue;
      if (nextBusinessTime(t) > t) continue;
      const eligible = state.clients.filter(
        (c) =>
          c.active &&
          o.candidateIds.includes(c.id) &&
          !o.offers.some((x) => x.clientId === c.id),
      );
      const candidate = eligible.find((c) => !busy.has(c.id));
      if (!candidate) {
        if (!eligible.length) {
          o.phase = "unfilled";
          history(
            o,
            "Reviewed list exhausted. Review more clients or close this opening.",
          );
        }
        continue;
      }
      const minutes = sameCentralDay(t, o.startsAt) ? 15 : 60;
      const deadline = Math.min(
        addBusinessMinutes(t, minutes),
        o.startsAt - 3_600_000,
      );
      const offer: Offer = {
        id: id(),
        clientId: candidate.id,
        createdAt: t,
        deadline,
        status: "sending",
      };
      o.offers.push(offer);
      o.phase = "offering";
      busy.add(candidate.id);
      history(
        o,
        `Offered to ${candidate.name}; reply by ${centralLabel(deadline)}.`,
      );
      message(
        o,
        candidate.id,
        `Hi ${candidate.name.split(" ")[0]}! Juniper Salon has a ${o.service.toLowerCase()} with ${o.stylist} on ${centralLabel(o.startsAt)}. Reply YES or NO by ${centralLabel(deadline)}. The slot is not held after that deadline. Reply STOP to leave the waitlist.`,
        offer,
        candidate.deliveryFails,
      );
    }
    state.now = t;
  }
  setHandler(getSalon, () => ({ ...state, now: now() }));
  setHandler(salonCommand, (cmd): CommandResult => {
    tick();
    const fail = (message: string) => ({ ok: false, message });
    let result = "Saved";
    if (cmd.type === "advance") {
      if (
        !input.demo ||
        !Number.isFinite(cmd.minutes) ||
        cmd.minutes <= 0 ||
        cmd.minutes > 10080
      )
        return fail("Invalid demo time jump.");
      offset += cmd.minutes * 60_000;
      state.clockOffset = offset;
      result = "Demo clock advanced";
    } else if (cmd.type === "addClient") {
      if (
        state.clients.some(
          (c) =>
            c.id === cmd.client.id ||
            (c.active &&
              normalizePhone(c.mobile) === normalizePhone(cmd.client.mobile)),
        )
      )
        return fail("This mobile number already has a waitlist request.");
      state.clients.push({ ...cmd.client, active: true, joinedAt: now() });
      state.clients.sort((a, b) => a.joinedAt - b.joinedAt);
    } else if (cmd.type === "removeClient") {
      const c = state.clients.find((x) => x.id === cmd.clientId);
      if (!c) return fail("Client not found.");
      c.active = false;
      for (const o of state.openings) {
        const offer = current(o);
        if (offer?.clientId === c.id) {
          endOffer(
            o,
            offer,
            "canceled",
            "Client removed from waitlist by staff.",
          );
          message(
            o,
            c.id,
            "You have been removed from the Juniper Salon waitlist. Your outstanding offer is no longer active.",
            offer,
          );
        }
      }
    } else if (cmd.type === "resolve") {
      const a = state.alerts.find((x) => x.id === cmd.alertId);
      if (!a) return fail("Alert not found.");
      a.resolved = true;
    } else if (cmd.type === "createOpening") {
      if (state.openings.some((x) => x.id === cmd.id))
        return { ok: true, message: "Opening already created" };
      if (
        !Number.isFinite(cmd.startsAt) ||
        cmd.startsAt <= now() + 3_600_000 ||
        cmd.startsAt > now() + 90 * 86_400_000
      )
        return fail(
          "Choose an appointment more than one hour away and within 90 days.",
        );
      if (
        !["Haircut", "Color", "Blowout"].includes(cmd.service) ||
        !["Carla", "Lena"].includes(cmd.stylist) ||
        ![30, 45, 60, 90, 120].includes(cmd.duration)
      )
        return fail("Choose a valid service, stylist, and duration.");
      if (
        state.openings.some(
          (o) =>
            o.stylist === cmd.stylist &&
            !["closed", "unfilled"].includes(o.phase) &&
            cmd.startsAt < o.startsAt + o.duration * 60_000 &&
            cmd.startsAt + cmd.duration * 60_000 > o.startsAt,
        )
      )
        return fail("This stylist already has an overlapping opening.");
      state.openings.unshift({
        id: cmd.id,
        service: cmd.service,
        stylist: cmd.stylist,
        startsAt: cmd.startsAt,
        duration: cmd.duration,
        phase: "review",
        candidateIds: [],
        offers: [],
        history: [{ at: now(), text: "Opening added. Staff review required." }],
        squareUpdated: false,
        createdAt: now(),
      });
    } else {
      const o = state.openings.find((x) => x.id === cmd.openingId);
      if (!o) return fail("Opening not found.");
      if (cmd.type === "start") {
        if (
          !["review", "unfilled"].includes(o.phase) ||
          now() >= o.startsAt - 3_600_000
        )
          return fail("This opening cannot start outreach.");
        if (
          state.openings.some(
            (other) =>
              other.id !== o.id &&
              other.stylist === o.stylist &&
              !["closed", "unfilled"].includes(other.phase) &&
              o.startsAt < other.startsAt + other.duration * 60_000 &&
              o.startsAt + o.duration * 60_000 > other.startsAt,
          )
        )
          return fail(
            "This stylist already has an overlapping active or filled opening.",
          );
        const ids = state.clients
          .filter(
            (c) =>
              c.active &&
              cmd.candidateIds.includes(c.id) &&
              c.service === o.service &&
              (c.stylist === "Any stylist" || c.stylist === o.stylist) &&
              !o.offers.some((x) => x.clientId === c.id),
          )
          .map((c) => c.id);
        if (!ids.length)
          return fail(
            "Select at least one matching client who has not already been contacted.",
          );
        o.candidateIds = ids;
        o.phase = "queued";
        history(
          o,
          "Staff reviewed availability and stylist capabilities. Outreach approved.",
        );
        result =
          nextBusinessTime(now()) > now()
            ? "Queued for the next business morning"
            : "Outreach started";
      } else if (cmd.type === "square") {
        if (o.phase !== "filled")
          return fail("Only confirmed appointments can be marked in Square.");
        if (!o.squareUpdated) {
          o.squareUpdated = true;
          history(
            o,
            "Staff marked Square updated, including any later appointment change.",
          );
        }
      } else if (cmd.type === "close") {
        if (o.phase === "filled") {
          alert(
            o,
            "conflict",
            "Already confirmed. Resolve this booking conflict personally; the client remains confirmed.",
          );
          history(o, "Staff reported an outside booking after confirmation.");
          result = "Conflict flagged. Confirmation preserved.";
        } else {
          const offer = current(o);
          if (offer) {
            offer.status = "canceled";
            message(
              o,
              offer.clientId,
              "Sorry, this opening at Juniper Salon is no longer available. You are still on our waitlist for another opening.",
              offer,
            );
          }
          o.phase = "closed";
          history(o, "Staff closed the opening / booked elsewhere.");
          result = "Opening closed";
        }
      } else if (cmd.type === "reply") {
        const offer = o.offers.find((x) => x.id === cmd.offerId);
        if (!offer) return fail("Offer not found.");
        const c = state.clients.find((x) => x.id === offer.clientId)!;
        const reply = cmd.text.trim().toUpperCase();
        if (!reply || cmd.text.length > 1000)
          return fail("Enter a reply of 1–1000 characters.");
        state.messages.push({
          id: id(),
          openingId: o.id,
          clientId: c.id,
          offerId: offer.id,
          direction: "in",
          text: cmd.text.trim(),
          at: now(),
          status: "received",
        });
        if (reply === "STOP") {
          c.active = false;
          for (const other of state.openings) {
            const active = current(other);
            if (active?.clientId === c.id)
              endOffer(
                other,
                active,
                "canceled",
                `${c.name} opted out of the waitlist.`,
              );
          }
          message(
            o,
            c.id,
            "You are off the Juniper Salon waitlist. Any already confirmed appointment is unchanged.",
            offer,
          );
          result = "Client removed from waitlist";
        } else if (offer.status === "accepted" && reply === "YES") {
          result = "Already confirmed — no duplicate booking";
        } else if (
          offer.status !== "waiting" ||
          now() >= offer.deadline ||
          o.phase !== "offering"
        ) {
          message(
            o,
            c.id,
            "Sorry, that offer is no longer available. Your reply did not book an appointment. Any existing confirmed appointment is unchanged.",
            offer,
          );
          result = "Late or inactive reply — no booking made";
        } else if (reply === "YES") {
          offer.status = "accepted";
          o.phase = "filled";
          o.confirmedClientId = c.id;
          c.active = false;
          history(
            o,
            `${c.name} accepted in time. Confirmed; staff must update Square.`,
          );
          message(
            o,
            c.id,
            `You’re confirmed! ${o.service} with ${o.stylist} at Juniper Salon on ${centralLabel(o.startsAt)}. We look forward to seeing you.`,
            offer,
          );
          result = "Appointment confirmed";
        } else if (reply === "NO") {
          endOffer(
            o,
            offer,
            "declined",
            `${c.name} declined. Request remains on the waitlist.`,
          );
          result = "Declined; moving to the next client";
        } else {
          alert(o, "reply", `${c.name}: “${cmd.text.trim()}”`, offer.id);
          history(
            o,
            `Unclear reply from ${c.name}; staff attention requested.`,
          );
          result = "Flagged for staff; deadline keeps running";
        }
      }
    }
    tick();
    state.revision++;
    dirty = true;
    return { ok: true, message: result };
  });
  while (true) {
    dirty = false;
    tick();
    const pending = state.messages.filter((m) => m.status === "pending");
    if (pending.length) {
      // Reserve state is already durable before this side effect begins.
      for (const m of pending) {
        const o = state.openings.find((x) => x.id === m.openingId)!;
        const offer = o.offers.find((x) => x.id === m.offerId);
        const isOffer =
          offer &&
          m.id ===
            state.messages.find(
              (x) => x.offerId === offer.id && x.direction === "out",
            )?.id;
        if (
          isOffer &&
          (offer.status !== "sending" || now() >= offer.deadline)
        ) {
          m.status = "failed";
          continue;
        }
        try {
          const receipt = await deliverMessage(m, workflowInfo().workflowId);
          m.status = receipt.delivered ? "sent" : "failed";
        } catch {
          m.status = "failed";
        }
        if (m.status === "failed") {
          alert(
            o,
            "delivery",
            `Message to ${state.clients.find((c) => c.id === m.clientId)?.name} failed. Check contact details${isOffer ? "; moving to the next client" : "; follow up manually"}.`,
          );
          if (isOffer && offer.status === "sending")
            endOffer(
              o,
              offer,
              "failed",
              "Offer could not be delivered. Moving to the next client.",
            );
        } else if (isOffer && offer.status === "sending")
          offer.status = "waiting";
        state.revision++;
      }
      continue;
    }
    const t = now();
    const wakeups = state.openings
      .flatMap((o) => {
        if (!["queued", "offering", "review"].includes(o.phase)) return [];
        return [
          o.startsAt - 3_600_000,
          ...(current(o) ? [current(o)!.deadline] : []),
          ...(o.phase === "queued" && nextBusinessTime(t) > t
            ? [nextBusinessTime(t)]
            : []),
        ];
      })
      .filter((x) => x > t);
    if (wakeups.length)
      await condition(() => dirty, Math.max(1, Math.min(...wakeups) - t));
    else await condition(() => dirty);
  }
}
