# Assessment evidence

Captured October 6, 2026 against the local Temporal dev server.

- `dashboard-desktop.jpg`: desktop dashboard, active next-day offer, unclear-reply alert with a running deadline, and a completed appointment with Square checked off.
- `dashboard-mobile.jpg`: the same real workflow state at a 390-pixel phone viewport. Verified no document-level horizontal overflow.
- `temporal-workflow.jpg`: the running `juniper-salon-demo-v1` Workflow in Temporal Web, with Updates, Activities, timers, and history visible.
- `test-results.txt`: output from the final integration suite against the real local Temporal server.

## Browser walkthrough verified

1. Staff deselected morning-only clients for the 1 PM opening and approved Mia and Sophie.
2. Mia's unclear reply appeared prominently without pausing the deadline.
3. Advancing the demo clock expired Mia's offer and contacted Sophie.
4. Mia's late YES did not take Sophie's offer.
5. Sophie's timely YES filled the opening, removed her waitlist request, and created the manual Square task.
6. Staff checked off the Square update.
7. A next-day color appointment matched the service/stylist, let staff exclude Tuesday-only availability, and offered Olivia one hour to reply.
8. API and Worker restarts preserved the same existing offers and recorded history.
9. The UI rendered at desktop and phone breakpoints; no browser console errors were reported.

All names and numbers are fictional. SMS delivery is simulated. Square is not connected.
