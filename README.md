# Juniper Salon — a reliable waitlist

A working local prototype adapted from the Temporal assessment starter. The website lets Lena and Carla review matching clients, send one invitation at a time, handle exceptions, and record the manual Square handoff. **Temporal is the source of truth for every opening, offer, response deadline, and waitlist request.**

## Run

Requires Node.js 20+ and Docker Desktop, running.

```sh
npm install
npm run dev
```

- Website: <http://localhost:3000>
- Temporal event history: <http://localhost:8233>
- `npm run typecheck` checks the TypeScript sources.
- `npm test` runs the calendar and real-server Workflow integration tests. Start Temporal first with `npm run dev` or `docker compose up -d temporal`.

The launcher automatically finds Docker Desktop's Compose plugin on macOS when `docker compose` is not on PATH. Alternatively, with an existing Temporal server on port 7233, run `npm run dev:worker` and `npm run dev:api` separately. `TEMPORAL_ADDRESS` selects another server for these commands.

The default workspace is `juniper-salon-demo-v1`, containing eight fictional clients and one opening for review. Its clock starts Tuesday, October 6, 2026 at 10 AM Central and moves naturally. The demo toolbar can advance it to make long waits practical to demonstrate. **Real Temporal timers still drive deadlines without browser polling or clock buttons.**

Restarting the API or Worker reconnects to the same durable workspace. Reloading the page does not reset it. Use `SALON_WORKFLOW_ID=juniper-another-demo npm run dev:api` for a fresh isolated demo workspace; stop the previous API first. `DEMO_MODE=false` starts an empty workspace using the real clock and disables time-jump commands, but still uses simulated SMS.

## Demonstrate it in five minutes

1. **Review & start** on the haircut opening. Read general availability and deselect anyone who cannot attend. The system preserves join order, regardless of selection order.
2. **View texts & simulate reply → Ask a question.** An amber alert shows the message, deadline, and remaining time. The offer remains active; staff follow up using the salon phone.
3. Close the dialog and use **+15 min**. The next client receives an offer. Reopen texts, select the older conversation, and send **YES**: the late reply cannot book. Select the current conversation and send **YES**: the slot becomes filled and the request leaves the waitlist.
4. **Mark updated in Square** records that staff added the booking and moved or canceled any existing later appointment. It does not call Square.
5. Add another opening, or use **Try overnight**. This jumps to 9 PM and opens the intake form for the next day. Approve the reviewed list: it stays **Queued** with no offer until 9 AM the next business day. Advance hours to demonstrate morning release.

Other scenarios:

- Include fictional Ruby James to demonstrate an undeliverable text. Her demo number intentionally fails; the workflow flags it and proceeds to the next reviewed client.
- In **Details**, choose **Close / booked elsewhere**. An outstanding offer is canceled and receives an apology. If already filled, the action reports a conflict and preserves the confirmation.
- Start two compatible openings. A client cannot have two active offers. The second queue waits or selects its next available reviewed client.
- Stop/restart the Worker while an offer is waiting. Its deadline and offer identity persist, and its SMS Activity is not sent twice.
- Use the Waitlist tab to add/remove requests; Activity shows the full staff-readable history.

## Customer rules implemented

| Need                      | Behavior                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fairness and fit          | Earliest join date first; exact service and required stylist match; staff reviews general availability and stylist capability before approving.                                             |
| One invitation at a time  | At most one active offer per opening and per client across the salon.                                                                                                                       |
| Response windows          | Same Central calendar day: 15 minutes. Later dates: 60 minutes.                                                                                                                             |
| Business hours            | New offers only Monday–Saturday, 9 AM–7 PM Central. Remaining response time carries to the next business day, skipping Sunday. Central daylight saving changes are handled.                 |
| Arrival time              | Every offer ends no later than one hour before its appointment. No new offer at/after that cutoff.                                                                                          |
| Replies                   | Exact YES accepts; NO declines; STOP removes the request. Other replies alert staff while the deadline continues.                                                                           |
| Late and repeated replies | Stale offers cannot win. Repeating YES on an accepted offer does not book twice.                                                                                                            |
| Waitlist membership       | Declined, timed-out, failed, and canceled offers retain the request. Acceptance or STOP removes it.                                                                                         |
| Failure and recovery      | Delivery failures alert and advance; transient Activity failures retry; workflow state and timers survive Worker/API restart.                                                               |
| Conflicts                 | Staff cancel outreach for an outside booking. Already accepted bookings remain confirmed and get a conflict alert.                                                                          |
| Exhausted lists           | Unfilled openings allow review of additional, not-yet-contacted clients or closure.                                                                                                         |
| Staff information         | Current recipient, reply deadline, remaining time, outcome, message thread, history, and unresolved exceptions. Responsive desktop and phone layouts.                                       |
| Square handoff            | Separate filled and Square-updated states; existing later appointments are called out.                                                                                                      |
| Business outcome          | Filled last-minute openings / all recorded openings created within 48 hours of appointment, including still-pending ones; 50% target. Demo counts are labeled and are not business results. |

## How Temporal is used

`src/workflows.ts` implements a long-lived **salon entity Workflow**. A single authoritative owner is deliberate for this small salon: staff from two devices cannot race each other into double offers or double acceptance. Synchronous Update handlers check and mutate reservations atomically, with no await between validation and commitment. The browser gets an acknowledged result from each Update; Queries read the current state. Update IDs deduplicate an HTTP retry.

The main loop uses durable `condition` timers for the next offer deadline, business opening, or arrival cutoff. It wakes for staff/client Updates as well as time. The calendar is deterministic and independent of the Worker machine's timezone. The API separately projects wall-clock time for the browser countdown because Workflow Queries must not be treated as a wall clock.

Outbound texts are queued in Workflow state before calling the `deliverMessage` Activity. It has bounded Temporal retries and a stable message key. The local simulated provider writes an idempotency receipt to `.data/sms/`; retries do not produce extra messages. Temporal's event history supplies recovery and audit evidence. No workflow state is stored in Express memory or browser storage.

```text
Staff / client simulator → Express → Temporal Update
                                      ↓
                            Salon Workflow (atomic state)
                            ├─ business calendar + durable timers
                            ├─ client and opening reservations
                            ├─ outcomes, alerts, Square checkoff
                            └─ delivery Activity → local SMS simulator
Browser ← Query ← saved Workflow state
```

The implementation follows Temporal's [TypeScript guide](https://docs.temporal.io/develop/typescript) and [Workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing) model.

## Prototype boundaries

- SMS is **simulated**. No real client is contacted. There is no SMS provider, webhook authentication, delivery callback, or real phone-number ownership verification.
- Square and Google Sheets are **not connected**. Staff enter waitlist requests here and update Square manually. An outside booking is unknown until staff report it; this prototype cannot prevent an independent Square booking race.
- The API binds to `127.0.0.1`, has no user authentication, and is intended for local assessment use. A phone-sized layout is supported, but remote phone access needs a secure deployment.
- The single entity Workflow is appropriate for a bounded demo. Before production, add authenticated roles, a real idempotent SMS adapter, provider webhook deduplication, durable provider receipts, history rollover/archival (`continueAsNew`), retention policies, and an operational reconciliation process for external calendar conflicts. Persist the local receipt directory if using this simulator across machines.
- The calendar uses current US post-2007 Central daylight saving rules and has no holiday overrides.

## Submission repository

The starter requires a new **public** repository, not a fork. Keep the configured submission origin (`ynguyen0/upskilling-post`) and do not add reviewers as collaborators. This implementation does not publish or push changes automatically. Evidence and a recorded browser walkthrough are described in `evidence/README.md`.
