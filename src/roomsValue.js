// Rooms-only value of a group booking (Yaneer's Δ, restricted to rooms).
//   Δ_rooms = group room revenue − displaced transient revenue − CPOR × occupied nights − concessions
// Group room revenue uses recognized nights: NGTD = actual pickup only;
// GTD = max(actual pickup, guaranteed nights) because attrition is billed.
// The result is NOT floored at 0 — a negative Δ means the booking loses money
// versus holding the rooms for transient guests. F&B and meeting rental are
// not part of this value; the UI shows them beside it.
//
// Labels: CPOR (cost per occupied room) = Placeholder ($50 per the 10/7 doc,
// replace with the hotel's actual figure). Displacement = Estimated (transient
// forecast). Pickup/ADR = Simulated-model output.
export const CPOR_DEFAULT = 50;

export function computeRoomsValue({ adr, pickup, block, nights, dispCost = 0, cpor = CPOR_DEFAULT, contract = null, pinnedRoomRevenue }) {
  const contracted = (Number(block) || 0) * (Number(nights) || 0);
  const expectedNights = contracted * pickup;
  const guaranteed = Number(contract?.guaranteed_room_nights) || 0;
  const recognizedNights = Math.max(expectedNights, Math.min(guaranteed, contracted));
  const roomRevenue = pinnedRoomRevenue !== undefined ? pinnedRoomRevenue : Math.round(adr * recognizedNights);
  const occupiedNights = pinnedRoomRevenue !== undefined && adr > 0 ? pinnedRoomRevenue / adr : recognizedNights;
  const roomCost = Math.round(cpor * occupiedNights);
  const concessions = Number(contract?.concession_total) || 0;
  const delta = Math.round(roomRevenue - dispCost - roomCost - concessions);
  return { roomRevenue, recognizedNights, occupiedNights, roomCost, concessions, delta };
}
