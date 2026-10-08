// hotelConfig.js — hotel operating parameters used by the pricing model.
// Edit values here. Nothing in this file is a model output.
// Label: Placeholder = a test value until the hotel supplies the real figure.
export const HOTEL_CONFIG = {
  total_rooms: 220,
  baseline_adr: 164,
  group_discount_pct: 0.12,
  // Cost per occupied room-night (housekeeping, laundry, utilities). Placeholder.
  cpor: 50,
  // Meeting rental estimate used ONLY when no contract exists. Placeholder.
  meeting_rate_per_room_night: 18,
};
