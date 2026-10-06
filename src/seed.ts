import type { ClientRequest, Opening } from "./types";
export const DEMO_NOW = Date.parse("2026-10-06T15:00:00Z");
export function seedClients(now: number): ClientRequest[] {
  return [
    [
      "ava",
      "Ava Mitchell",
      "Haircut",
      "Any stylist",
      "Weekday mornings",
      "Thu, Oct 15 · 11:00 AM",
    ],
    ["mia", "Mia Chen", "Haircut", "Carla", "Tuesdays & Thursdays", ""],
    [
      "sophie",
      "Sophie Bennett",
      "Haircut",
      "Any stylist",
      "Flexible on weekdays",
      "",
    ],
    [
      "olivia",
      "Olivia Rivera",
      "Color",
      "Lena",
      "Weekday afternoons",
      "Fri, Oct 23 · 2:00 PM",
    ],
    ["emma", "Emma Wilson", "Haircut", "Lena", "Saturday afternoons", ""],
    [
      "grace",
      "Grace Park",
      "Blowout",
      "Any stylist",
      "Weekdays after 1 PM",
      "",
    ],
    ["isla", "Isla Brooks", "Color", "Any stylist", "Tuesdays, any time", ""],
    ["ruby", "Ruby James", "Haircut", "Carla", "Weekday mornings", ""],
  ].map(([id, name, service, stylist, availability, existingBooking], i) => ({
    id,
    name,
    mobile: `+1 312 555 01${String(i + 1).padStart(2, "0")}`,
    service,
    stylist,
    availability,
    existingBooking,
    joinedAt: now - (9 - i) * 86_400_000,
    active: true,
    deliveryFails: id === "ruby",
  }));
}
export function seedOpenings(now: number): Opening[] {
  return [
    {
      id: "opening-welcome",
      service: "Haircut",
      stylist: "Carla",
      startsAt: now + 3 * 3_600_000,
      duration: 45,
      phase: "review",
      candidateIds: [],
      offers: [],
      history: [
        {
          at: now,
          text: "Cancellation added. Review client availability before starting.",
        },
      ],
      squareUpdated: false,
      createdAt: now,
    },
  ];
}
