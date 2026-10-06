export type ClientRequest = {
  id: string;
  name: string;
  mobile: string;
  service: string;
  stylist: string;
  availability: string;
  joinedAt: number;
  active: boolean;
  existingBooking?: string;
  deliveryFails?: boolean;
};
export type Offer = {
  id: string;
  clientId: string;
  createdAt: number;
  deadline: number;
  status:
    | "sending"
    | "waiting"
    | "accepted"
    | "declined"
    | "timed_out"
    | "failed"
    | "canceled";
};
export type Opening = {
  id: string;
  service: string;
  stylist: string;
  startsAt: number;
  duration: number;
  phase: "review" | "queued" | "offering" | "filled" | "unfilled" | "closed";
  candidateIds: string[];
  offers: Offer[];
  history: { at: number; text: string }[];
  confirmedClientId?: string;
  squareUpdated: boolean;
  createdAt: number;
};
export type Message = {
  id: string;
  openingId: string;
  clientId: string;
  offerId?: string;
  direction: "in" | "out";
  text: string;
  at: number;
  status: "pending" | "sent" | "failed" | "received";
  failDelivery?: boolean;
};
export type Alert = {
  id: string;
  openingId: string;
  offerId?: string;
  text: string;
  kind: "reply" | "delivery" | "conflict";
  resolved: boolean;
  at: number;
};
export type SalonState = {
  demo: boolean;
  now: number;
  clockOffset: number;
  clients: ClientRequest[];
  openings: Opening[];
  messages: Message[];
  alerts: Alert[];
  revision: number;
};
export type Command =
  | {
      type: "createOpening";
      id: string;
      service: string;
      stylist: string;
      startsAt: number;
      duration: number;
    }
  | { type: "start"; openingId: string; candidateIds: string[] }
  | { type: "reply"; openingId: string; offerId: string; text: string }
  | { type: "close"; openingId: string }
  | { type: "square"; openingId: string }
  | { type: "resolve"; alertId: string }
  | { type: "addClient"; client: ClientRequest }
  | { type: "removeClient"; clientId: string }
  | { type: "advance"; minutes: number };
export type CommandResult = { ok: boolean; message: string };
export type SalonInput = {
  demo: boolean;
  initialNow?: number;
  clients: ClientRequest[];
  openings?: Opening[];
};
