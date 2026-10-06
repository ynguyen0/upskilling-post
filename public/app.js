const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let state,
  view = "openings",
  filter = "all",
  modal = null,
  connected = false,
  pending = false,
  fetchedAt = 0;
const fmt = (n, options = {}) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    ...options,
  }).format(n);
const time = (n) => fmt(n, { hour: "numeric", minute: "2-digit" });
const date = (n) =>
  fmt(n, { weekday: "short", month: "short", day: "numeric" });
const full = (n) => `${date(n)} · ${time(n)} CT`;
const client = (id) => state.clients.find((c) => c.id === id);
const initials = (name) =>
  name
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("");
const active = (o) =>
  o.offers.find((x) => ["waiting", "sending"].includes(x.status));
const phaseLabel = {
  review: "Ready for review",
  queued: "Queued",
  offering: "Awaiting reply",
  filled: "Filled",
  unfilled: "Unfilled",
  closed: "Closed",
};
const badge = (o) =>
  `<span class="badge ${o.phase === "offering" ? "waiting" : o.phase}">${o.phase === "offering" ? "● " : ""}${phaseLabel[o.phase]}</span>`;
const now = () => (state ? state.now + (Date.now() - fetchedAt) : Date.now());
function remaining(deadline) {
  const min = Math.max(0, Math.ceil((deadline - now()) / 60000));
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`;
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  setTimeout(() => ($("#toast").hidden = true), 4200);
}
async function api(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.json();
  if (!r.ok)
    throw new Error(
      body.error || body.message || "Unable to save. Please retry.",
    );
  return body;
}
async function refresh(force = false) {
  try {
    const next = await api("/api/state");
    const changed =
      !state ||
      next.revision !== state.revision ||
      JSON.stringify(next.openings) !== JSON.stringify(state.openings) ||
      JSON.stringify(next.messages) !== JSON.stringify(state.messages);
    state = next;
    fetchedAt = Date.now();
    connected = true;
    $("#error").hidden = true;
    $("#connection-dot").classList.remove("offline");
    $("#connection-label").textContent = "Progress saved";
    if (changed || force) render();
    updateClock();
  } catch (e) {
    connected = false;
    $("#connection-dot").classList.add("offline");
    $("#connection-label").textContent = "Reconnecting";
    $("#error").hidden = false;
    $("#error").textContent =
      "Unable to reach the salon service. Saved progress is safe. Showing the last known status; actions will be available when connected.";
    if (!state)
      $("#content").innerHTML =
        '<div class="skeleton">Waiting for the salon service…</div>';
  }
}
async function command(body) {
  if (pending) return false;
  if (!connected) {
    toast("Please wait for the salon service to reconnect.");
    return false;
  }
  pending = true;
  const key = crypto.randomUUID();
  document
    .querySelectorAll("button[type=submit]")
    .forEach((b) => (b.disabled = true));
  try {
    let result;
    try {
      result = await api("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "TypeError")
        result = await api("/api/command", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        });
      else throw e;
    }
    await refresh(true);
    toast(result.message);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  } finally {
    pending = false;
    document
      .querySelectorAll("button[type=submit]")
      .forEach((b) => (b.disabled = false));
  }
}
function updateClock() {
  if (!state) return;
  document
    .querySelectorAll("[data-deadline]")
    .forEach((el) => (el.textContent = remaining(Number(el.dataset.deadline))));
  const clock = $("#demo-clock-text");
  if (clock) clock.textContent = full(now());
}
function metric(label, value, note, extra = "") {
  return `<div class="metric ${extra}"><div class="metric-label">${label}<span>${extra ? "↗" : "◦"}</span></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`;
}
function render() {
  const open = state.openings.filter(
    (o) => !["filled", "closed", "unfilled"].includes(o.phase),
  );
  const filled = state.openings.filter((o) => o.phase === "filled"),
    square = filled.filter((o) => !o.squareUpdated);
  const tracked = state.openings.filter(
      (o) => o.startsAt - o.createdAt <= 48 * 3600000,
    ),
    rate = tracked.length
      ? Math.round(
          (tracked.filter((o) => o.phase === "filled").length /
            tracked.length) *
            100,
        )
      : 0;
  $("#opening-count").textContent = open.length;
  $("#waitlist-count").textContent = state.clients.filter(
    (c) => c.active,
  ).length;
  $("#today").textContent =
    `${date(state.now).toUpperCase()}  /  YOUR FRONT DESK`;
  $("#metrics").innerHTML =
    metric(
      "Active openings",
      open.length,
      `${open.filter((o) => active(o)).length} waiting for a reply`,
    ) +
    metric(
      "Appointments filled",
      filled.length,
      `${square.length} ${square.length === 1 ? "needs" : "need"} a Square update`,
    ) +
    metric(
      "Clients on the waitlist",
      state.clients.filter((c) => c.active).length,
      "A little closer to their next visit",
    ) +
    `<div class="metric goal"><div class="metric-label">Last-minute fill rate <span>↗</span></div><div class="metric-value">${rate}% <span style="font-size:11px;color:#879271;letter-spacing:0">/ 50% goal</span></div><div class="progress"><i style="width:${rate}%"></i></div><div class="metric-note">${tracked.length} opening${tracked.length === 1 ? "" : "s"} tracked · ${state.demo ? "demo workspace" : "all recorded openings"}</div></div>`;
  const alerts = state.alerts.filter((a) => !a.resolved);
  $("#attention").innerHTML = alerts
    .map(
      (a) =>
        `<div class="alert-box"><span class="alert-icon">!</span><div class="alert-text"><strong>${a.kind === "reply" ? "Reply needs your attention" : a.kind === "conflict" ? "Booking conflict · confirmed client" : "Message delivery failed"}</strong><p>${esc(a.text)}${alertContext(a)}</p></div><button class="button small" data-action="details" data-id="${esc(a.openingId)}">View opening</button><button class="text-button" data-action="resolve" data-id="${a.id}">Mark handled</button></div>`,
    )
    .join("");
  if (view === "openings") renderOpenings();
  else if (view === "waitlist") renderWaitlist();
  else renderActivity();
  $("#demo-content").innerHTML =
    `<div class="demo-clock"><b id="demo-clock-text">${full(now())}</b><small>${state.demo ? "Demo clock moves forward naturally; jump ahead to explore deadlines." : "Real salon clock · Central Time"}</small></div><div class="demo-actions">${state.demo ? '<button class="button small" data-action="advance" data-minutes="15">＋15 min</button><button class="button small" data-action="advance" data-minutes="60">＋1 hour</button><button class="button small" data-action="night">Try overnight</button>' : ""}<a class="button small" href="http://localhost:8233/namespaces/default/workflows/${encodeURIComponent(state.workflowId)}" target="_blank" rel="noopener">View Temporal ↗</a></div>`;
  if (modal?.type === "conversation") renderConversation(false);
  if (modal?.type === "details") renderDetails(false);
}
function alertContext(a) {
  const o = state.openings.find((x) => x.id === a.openingId),
    offer = o?.offers.find((x) => x.id === a.offerId);
  if (!offer) return "";
  return ["waiting", "sending"].includes(offer.status)
    ? `<br>Reply by ${full(offer.deadline)} · <b><span data-deadline="${offer.deadline}">${remaining(offer.deadline)}</span> remaining.</b> Deadline keeps running.`
    : `<br>Offer ${offer.status.replace("_", " ")} · follow-up still needs review.`;
}
function renderOpenings() {
  const counts = {
    all: state.openings.length,
    active: state.openings.filter((o) =>
      ["review", "queued", "offering"].includes(o.phase),
    ).length,
    filled: state.openings.filter((o) => o.phase === "filled").length,
    closed: state.openings.filter((o) =>
      ["unfilled", "closed"].includes(o.phase),
    ).length,
  };
  const list = state.openings.filter(
    (o) =>
      filter === "all" ||
      (filter === "active" &&
        ["review", "queued", "offering"].includes(o.phase)) ||
      (filter === "filled" && o.phase === "filled") ||
      (filter === "closed" && ["closed", "unfilled"].includes(o.phase)),
  );
  $("#content").innerHTML =
    `<div class="section-heading"><div><h2>Your openings</h2><p>A considered invitation. A spot worth filling.</p></div><span class="hint">All times Central</span></div><div class="tabs" role="tablist">${[
      ["all", "All openings"],
      ["active", "In progress"],
      ["filled", "Filled"],
      ["closed", "Closed / unfilled"],
    ]
      .map(
        ([key, label]) =>
          `<button role="tab" aria-selected="${filter === key}" class="tab ${filter === key ? "active" : ""}" data-action="filter" data-id="${key}">${label}<span>${counts[key]}</span></button>`,
      )
      .join(
        "",
      )}</div><div class="opening-grid">${list.map(card).join("")}<div class="empty-card"><div><span class="sprout">✳</span><h3>A cancellation can be a fresh start.</h3><p>Add an opening, review your waitlist,<br>and let the next invitation take care of itself.</p><button class="button soft small" data-action="newOpening">＋ Add an opening</button></div></div></div><div class="rule-strip"><span class="rule-icon">♧</span><span><b>Thoughtful by design.</b> Clients are contacted in waitlist order, one at a time. You’re always in control.</span><span class="rule-right">15 min today · 1 hour ahead</span></div>`;
}
function card(o) {
  const offer = active(o),
    c = client(offer?.clientId || o.confirmedClientId),
    match = state.clients.filter((x) => matches(x, o)).length;
  let panel = "";
  if (offer)
    panel = `<div class="offer-label">${offer.status === "sending" ? "Sending invitation" : "Currently offered to"}</div><div class="person"><span class="avatar">${esc(initials(c.name))}</span><div><div class="person-name">${esc(c.name)}</div><div class="person-sub">Reply by ${time(offer.deadline)} · ${date(offer.deadline)}</div></div><div class="deadline"><span class="countdown" data-deadline="${offer.deadline}">${remaining(offer.deadline)}</span><small>until deadline</small></div></div>`;
  else if (o.phase === "filled")
    panel = `<div class="offer-label">Appointment confirmed</div><div class="person"><span class="avatar">${esc(initials(c.name))}</span><div><div class="person-name">${esc(c.name)}</div><div class="person-sub">${o.squareUpdated ? "✓ Updated in Square" : "Add this appointment to Square"}</div></div><span style="margin-left:auto;color:#7c965d">✓</span></div>`;
  else if (o.phase === "review")
    panel = `<div class="offer-label">${match} matching request${match === 1 ? "" : "s"} on your waitlist</div><p class="review-copy">A quick check of availability, then we’ll reach out to the earliest matching client.</p>`;
  else if (o.phase === "queued")
    panel = `<div class="offer-label">Outreach approved</div><p class="review-copy">Waiting for business hours or for a matching client’s other offer to end. No overlapping invitations.</p>`;
  else
    panel = `<div class="offer-label">${o.phase === "closed" ? "Outreach closed" : "No appointment booked"}</div><p class="review-copy">${o.phase === "closed" ? "Outstanding offers are canceled. Clients stay on the waitlist." : "Review remaining requests or close this opening. Outreach stops one hour before the appointment."}</p>`;
  let action = `<button class="button small" data-action="details" data-id="${o.id}">View details</button>`;
  if (
    o.phase === "review" ||
    (o.phase === "unfilled" && now() < o.startsAt - 3600000)
  )
    action = `<button class="button primary small" data-action="review" data-id="${o.id}">Review ${o.phase === "unfilled" ? "remaining clients" : "& start"} <span>→</span></button>`;
  if (offer)
    action = `<button class="button small" data-action="conversation" data-id="${o.id}">View texts & simulate reply</button>`;
  if (o.phase === "filled" && !o.squareUpdated)
    action = `<button class="button primary small" data-action="square" data-id="${o.id}">✓ Mark updated in Square</button>`;
  return `<article class="opening-card"><div class="card-top"><div class="card-labels"><span class="slot-id">${date(o.startsAt).toUpperCase()}</span>${badge(o)}</div><h3>${esc(o.service)}</h3><div class="slot-meta">with ${esc(o.stylist)} <span>·</span> ${o.duration} minutes</div><div class="slot-time"><strong>◷ &nbsp; ${time(o.startsAt)}</strong><span>Stop offers at ${time(o.startsAt - 3600000)}</span></div></div><div class="offer-panel">${panel}</div>${o.phase === "filled" && c.existingBooking ? `<div class="mini-note">Also move or cancel: ${esc(c.existingBooking)}</div>` : ""}<div class="card-actions">${action}<button class="text-button" data-action="details" data-id="${o.id}">Details ↗</button></div></article>`;
}
function matches(c, o) {
  return (
    c.active &&
    c.service === o.service &&
    (c.stylist === "Any stylist" || c.stylist === o.stylist) &&
    !o.offers.some((x) => x.clientId === c.id)
  );
}
function renderWaitlist() {
  const clients = state.clients.filter((c) => c.active);
  $("#content").innerHTML =
    `<div class="section-heading"><div><h2>A spot on the list. Something to look forward to.</h2><p>Earliest requests first. Availability is always reviewed by staff.</p></div></div><div class="table-wrap"><table><thead><tr><th>Client / joined</th><th>Service</th><th>Stylist</th><th>Availability</th><th>Status</th><th></th></tr></thead><tbody>${clients.map((c) => `<tr><td><b>${esc(c.name)}</b><small>${esc(c.mobile)} · ${date(c.joinedAt)}</small></td><td>${esc(c.service)}</td><td>${esc(c.stylist)}</td><td>${esc(c.availability)}${c.existingBooking ? `<small>Booked: ${esc(c.existingBooking)}</small>` : ""}</td><td><span class="badge ${state.openings.some((o) => active(o)?.clientId === c.id) ? "waiting" : ""}">${state.openings.some((o) => active(o)?.clientId === c.id) ? "Offer active" : "Waiting"}</span>${c.deliveryFails ? "<small>Demo: delivery fails</small>" : ""}</td><td><button class="text-button" data-action="remove" data-id="${c.id}">Remove</button></td></tr>`).join("") || '<tr><td colspan="6">No active requests. Add a client to get started.</td></tr>'}</tbody></table></div>`;
}
function renderActivity() {
  const events = state.openings
    .flatMap((o) => o.history.map((h) => ({ ...h, o })))
    .sort((a, b) => b.at - a.at);
  $("#content").innerHTML =
    `<div class="section-heading"><div><h2>Every invitation has a story.</h2><p>Declines, timeouts, confirmations, and staff decisions — all in one place.</p></div></div><div class="history-list">${events.map((e) => `<div class="history-row"><time>${date(e.at)}<br>${time(e.at)}</time><div><b>${esc(e.o.service)} with ${esc(e.o.stylist)}</b><p>${esc(e.text)}</p></div></div>`).join("") || '<p class="hint">Activity will appear as you add openings.</p>'}</div>`;
}
function switchView(next) {
  view = next;
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#breadcrumb").textContent = {
    openings: "Openings",
    waitlist: "Waitlist",
    activity: "Activity",
  }[view];
  $("#page-title").textContent = {
    openings: "Make room for a good day.",
    waitlist: "Good things are worth the wait.",
    activity: "A little clarity, all day long.",
  }[view];
  $("#page-subtitle").textContent = {
    openings: "Fill the gaps. Keep the personal touch.",
    waitlist: "Every request remembered. Every invitation considered.",
    activity: "See what happened, without chasing a conversation.",
  }[view];
  $("#add-main").textContent =
    view === "waitlist" ? "＋ Add client" : "＋ Add opening";
  render();
}
function header(title, subtitle) {
  return `<div class="modal-header"><div><h2>${title}</h2><p>${subtitle}</p></div><button class="close-modal" data-action="dismiss" aria-label="Close dialog">×</button></div>`;
}
function show(html) {
  $("#modal-content").innerHTML = html;
  if (!$("#modal").open) $("#modal").showModal();
}
function closeModal() {
  modal = null;
  $("#modal").close();
}
function dateInput(at) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return parts.replace(" ", "T");
}
function centralInput(text) {
  const guess = Date.parse(text + "Z");
  let result = guess + 6 * 3600000;
  for (let i = 0; i < 3; i++) {
    const local = Date.parse(dateInput(result) + "Z");
    result += guess - local;
  }
  return result;
}
function newOpening() {
  modal = { type: "new" };
  show(
    `${header("Make a little room.", "Add the cancellation. You’ll review matching clients before any offer is sent.")}<form id="opening-form"><div class="modal-body form-grid"><label>Service<select name="service"><option>Haircut</option><option>Color</option><option>Blowout</option></select></label><label>Stylist<select name="stylist"><option>Carla</option><option>Lena</option></select></label><label class="full">Appointment date & time · Central<input name="startsAt" type="datetime-local" value="${dateInput(now() + 4 * 3600000)}" required></label><label>Duration<select name="duration"><option value="30">30 minutes</option><option value="45" selected>45 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option><option value="120">120 minutes</option></select></label><p class="hint">Offers stop one hour before the appointment. Texts only go out Mon–Sat, 9–7 Central.</p></div><div class="modal-footer"><button type="button" class="button" data-action="dismiss">Cancel</button><button class="button primary" type="submit">Add & review clients →</button></div></form>`,
  );
}
function review(id) {
  const o = state.openings.find((x) => x.id === id);
  modal = { type: "review", id };
  const candidates = state.clients.filter((c) => matches(c, o));
  show(
    `${header("A thoughtful first invitation.", `${esc(o.service)} with ${esc(o.stylist)} · ${full(o.startsAt)}`)}<form id="review-form" data-id="${id}"><div class="modal-body"><div class="notice">Check each client’s availability and that the stylist can perform this service. Selected clients are contacted in the order they joined — one at a time.</div>${candidates.map((c, i) => `<label class="candidate"><input type="checkbox" name="candidate" value="${c.id}" checked><span class="avatar">${esc(initials(c.name))}</span><div><b>${esc(c.name)}</b><div class="person-sub">${esc(c.availability)}<br>${esc(c.stylist)} · Joined ${date(c.joinedAt)}${c.deliveryFails ? " · Demo: undeliverable text" : ""}</div></div><span class="queue-number">${String(i + 1).padStart(2, "0")}</span></label>`).join("") || '<p class="hint">No uncontacted matching clients. Add a request to the waitlist, or close this opening.</p>'}<p class="hint">Clients with an active offer elsewhere will wait until it ends. Outside business hours, outreach waits for the next business morning.</p></div><div class="modal-footer"><button class="button" type="button" data-action="dismiss">Keep in review</button><button type="submit" class="button primary" ${candidates.length ? "" : "disabled"}>Approve & start outreach →</button></div></form>`,
  );
}
function addClient() {
  modal = { type: "addClient" };
  show(
    `${header("Someone to look forward to.", "Add a request from a client who called or texted the salon.")}<form id="client-form"><div class="modal-body form-grid"><label>Full name<input name="name" required maxlength="80" placeholder="e.g. Jamie Lee"></label><label>Mobile number<input name="mobile" required type="tel" placeholder="+1 312 555 0123"></label><label>Requested service<select name="service"><option>Haircut</option><option>Color</option><option>Blowout</option></select></label><label>Stylist preference<select name="stylist"><option>Any stylist</option><option>Carla</option><option>Lena</option></select></label><label class="full">Availability<input name="availability" required maxlength="200" placeholder="e.g. Saturday afternoons"></label><label class="full">Later appointment to move, if any<input name="existingBooking" maxlength="200" placeholder="e.g. October 23 at 2 PM"></label></div><div class="modal-footer"><button type="button" class="button" data-action="dismiss">Cancel</button><button class="button primary" type="submit">Add to waitlist</button></div></form>`,
  );
}
function renderDetails(open = true) {
  const o = state.openings.find((x) => x.id === modal.id);
  const html = `${header(`${esc(o.service)} with ${esc(o.stylist)}`, full(o.startsAt))}<div class="modal-body"><div class="detail-grid"><div><small>STATUS</small>${badge(o)}</div><div><small>ARRIVAL CUTOFF</small>${full(o.startsAt - 3600000)}</div></div>${o.phase === "filled" ? `<div class="notice">Confirmed for <b>${esc(client(o.confirmedClientId).name)}</b>. ${o.squareUpdated ? "Square is marked updated." : "Add the booking to Square and move or cancel any later appointment."}</div>` : ""}<div class="history-list">${o.history
    .slice()
    .reverse()
    .map(
      (h) =>
        `<div class="history-row"><time>${time(h.at)}</time><p>${esc(h.text)}</p></div>`,
    )
    .join(
      "",
    )}</div></div><div class="modal-footer">${o.offers.length ? `<button class="button" data-action="conversation" data-id="${o.id}">Texts & replies</button>` : ""}${o.phase !== "closed" ? `<button class="button danger" data-action="closeOpening" data-id="${o.id}">${o.phase === "filled" ? "Report booking conflict" : "Close / booked elsewhere"}</button>` : ""}</div>`;
  if (open) show(html);
  else $("#modal-content").innerHTML = html;
}
function renderConversation(open = true) {
  const o = state.openings.find((x) => x.id === modal.id);
  const offer =
    o.offers.find((x) => x.id === modal.offerId) ||
    active(o) ||
    o.offers.at(-1);
  if (!offer) return;
  modal.offerId = offer.id;
  const c = client(offer.clientId);
  const messages = state.messages.filter((m) => m.offerId === offer.id);
  const draft = $("#reply-text")?.value || "";
  const html = `${header(`A text for ${esc(c.name.split(" ")[0])}.`, `Client simulator · no real SMS is sent. For staff follow-up, use the salon phone: ${esc(c.mobile)}.`)}<div class="modal-body"><label class="hint" for="offer-select">Conversation</label><select id="offer-select">${o.offers.map((x) => `<option value="${x.id}" ${x.id === offer.id ? "selected" : ""}>${esc(client(x.clientId).name)} · ${x.status.replace("_", " ")} · ${time(x.createdAt)}</option>`).join("")}</select><div class="messages">${messages.map((m) => `<div class="bubble ${m.direction === "in" ? "incoming" : ""}">${esc(m.text)}<small>${m.direction === "out" ? "Juniper Salon" : "Client"} · ${time(m.at)} · ${m.status}</small></div>`).join("")}</div><div class="notice">${offer.status === "sending" ? "Delivering the invitation. Reply once the message has arrived." : offer.status === "waiting" ? `Reply deadline: ${full(offer.deadline)}. <b><span data-deadline="${offer.deadline}">${remaining(offer.deadline)}</span> remaining.</b>` : `This offer is ${offer.status.replace("_", " ")}. Replies to an expired offer cannot book the slot.`}</div><div class="reply-buttons"><button class="button primary" ${offer.status === "sending" ? "disabled" : ""} data-action="reply" data-text="YES">Reply YES</button><button class="button" ${offer.status === "sending" ? "disabled" : ""} data-action="reply" data-text="NO">Reply NO</button><button class="button" ${offer.status === "sending" ? "disabled" : ""} data-action="reply" data-text="Can I come half an hour later?">Ask a question</button><button class="text-button" ${offer.status === "sending" ? "disabled" : ""} data-action="reply" data-text="STOP">Reply STOP</button></div><form id="reply-form" class="reply-form"><label class="sr-only" for="reply-text">Client reply</label><input id="reply-text" maxlength="1000" required placeholder="Write a client reply…" value="${esc(draft)}"><button class="button" type="submit">Send</button></form></div>`;
  if (open) show(html);
  else {
    const focused = document.activeElement?.id;
    $("#modal-content").innerHTML = html;
    if (focused === "reply-text") $("#reply-text")?.focus();
  }
}
function confirmDialog(title, text, action, id) {
  modal = { type: "confirm", action, id };
  show(
    `${header(title, text)}<div class="modal-footer"><button class="button" data-action="dismiss">Go back</button><button class="button primary" data-action="confirm">Confirm</button></div>`,
  );
}
async function sendReply(text) {
  await command({
    type: "reply",
    openingId: modal.id,
    offerId: modal.offerId,
    text,
  });
  if ($("#reply-text")) $("#reply-text").value = "";
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.view) {
    switchView(b.dataset.view);
    return;
  }
  const a = b.dataset.action,
    id = b.dataset.id;
  if (!a) return;
  if (a === "dismiss") closeModal();
  if (a === "filter") {
    filter = id;
    renderOpenings();
  }
  if (a === "newOpening") newOpening();
  if (a === "review") review(id);
  if (a === "details") {
    modal = { type: "details", id };
    renderDetails();
  }
  if (a === "conversation") {
    modal = { type: "conversation", id };
    renderConversation();
  }
  if (a === "reply") await sendReply(b.dataset.text);
  if (a === "resolve") await command({ type: "resolve", alertId: id });
  if (a === "advance")
    await command({ type: "advance", minutes: Number(b.dataset.minutes) });
  if (a === "square")
    confirmDialog(
      "All set in Square?",
      "Confirm you’ve added this booking to Square and moved or canceled any later appointment.",
      "square",
      id,
    );
  if (a === "closeOpening")
    confirmDialog(
      "Handle this opening?",
      state.openings.find((o) => o.id === id).phase === "filled"
        ? "The client will stay confirmed. We’ll flag the conflict for you to resolve personally."
        : "Outstanding offers will be canceled and the client will receive an apology.",
      "close",
      id,
    );
  if (a === "remove")
    confirmDialog(
      "Remove this waitlist request?",
      "Any outstanding offer for this client will be canceled. Confirmed appointments stay unchanged.",
      "removeClient",
      id,
    );
  if (a === "confirm") {
    const m = modal;
    if (
      await command(
        m.action === "removeClient"
          ? { type: m.action, clientId: m.id }
          : { type: m.action, openingId: m.id },
      )
    )
      closeModal();
  }
  if (a === "night") {
    const target = centralInput(dateInput(now()).slice(0, 10) + "T21:00");
    const minutes = Math.ceil(
      ((target > now() ? target : target + 86400000) - now()) / 60000,
    );
    if (await command({ type: "advance", minutes })) {
      newOpening();
      $("#opening-form [name=startsAt]").value = dateInput(
        now() + 15 * 3600000,
      );
      toast(
        "It’s after hours. Add and approve an opening to see it queue for morning.",
      );
    }
  }
});
$("#add-main").addEventListener("click", () =>
  view === "waitlist" ? addClient() : newOpening(),
);
$("#modal").addEventListener("close", () => (modal = null));
document.addEventListener("change", (e) => {
  if (e.target.id === "offer-select") {
    modal.offerId = e.target.value;
    renderConversation();
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target,
    data = new FormData(form);
  if (form.id === "opening-form") {
    const id = "opening-" + crypto.randomUUID();
    if (
      await command({
        type: "createOpening",
        id,
        service: data.get("service"),
        stylist: data.get("stylist"),
        startsAt: centralInput(data.get("startsAt")),
        duration: Number(data.get("duration")),
      })
    )
      review(id);
  }
  if (form.id === "review-form") {
    if (
      await command({
        type: "start",
        openingId: form.dataset.id,
        candidateIds: data.getAll("candidate"),
      })
    )
      closeModal();
  }
  if (form.id === "client-form") {
    if (
      await command({
        type: "addClient",
        client: {
          id: crypto.randomUUID(),
          name: data.get("name"),
          mobile: data.get("mobile"),
          service: data.get("service"),
          stylist: data.get("stylist"),
          availability: data.get("availability"),
          existingBooking: data.get("existingBooking"),
          active: true,
          joinedAt: now(),
        },
      })
    )
      closeModal();
  }
  if (form.id === "reply-form") await sendReply($("#reply-text").value);
});
refresh();
setInterval(() => refresh(), 3000);
setInterval(updateClock, 1000);
