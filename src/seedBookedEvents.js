/**
 * seedBookedEvents.js
 *
 * Seeds realistic booked_events into Firestore to create a
 * compression scenario visible on the MERIT calendar.
 *
 * HOW TO RUN:
 *   1. Save this file in your project's /src folder (or anywhere)
 *   2. Add a temporary button in App.jsx that calls seedBookedEvents()
 *      OR run it once from a browser console after importing firebase
 *   3. Alternatively: paste into a Node script with firebase-admin
 *
 * EASIER METHOD — paste into App.jsx handleLogin temporarily:
 *   import { seedBookedEvents } from './seedBookedEvents';
 *   const handleLogin = () => { seedBookedEvents(db); ... }
 */

import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

function makeRoomDays(arrival, departure, rooms) {
  const result = {};
  const start = new Date(arrival);
  const end   = new Date(departure);
  for (let dt = new Date(start); dt < end; dt.setDate(dt.getDate() + 1)) {
    const key = dt.toISOString().slice(0, 10);
    result[key] = { ...rooms };
  }
  return result;
}

export async function seedBookedEvents(db) {
  const events = [

    // ── JULY 2026 — HIGH COMPRESSION WEEK (July 13–18) ──────────────────────
    // Large corporate group fills 180 rooms for 5 nights during summer peak
    {
      Account_Name:      'Nationwide Insurance Annual Summit',
      Event_Type:        'Corporate',
      Market_Segment:    'Insurance',
      Arrival_Date:      '2026-07-13',
      Departure_Date:    '2026-07-18',
      Nights:            5,
      Peak_Room_Block:   180,
      Attendees:         220,
      Forecasted_Occupancy: 0.89,
      Quoted_ADR:        172,
      Has_Meeting_Space: true,
      Uses_Ballroom:     true,
      Uses_Boardroom:    false,
      Num_Meeting_Rooms: 3,
      room_days: makeRoomDays('2026-07-13','2026-07-18',{ballroom:true,boardroom:false,executive_suite:false,salon:true}),
      Status:            'approved',
      _source:           'booked',
    },
    // Second group overlapping same week — creates compression
    {
      Account_Name:      'Ohio Dental Association',
      Event_Type:        'Association',
      Market_Segment:    'Healthcare',
      Arrival_Date:      '2026-07-15',
      Departure_Date:    '2026-07-19',
      Nights:            4,
      Peak_Room_Block:   35,
      Attendees:         60,
      Forecasted_Occupancy: 0.92,
      Quoted_ADR:        158,
      Has_Meeting_Space: true,
      Uses_Ballroom:     false,
      Uses_Boardroom:    true,
      Num_Meeting_Rooms: 1,
      room_days: makeRoomDays('2026-07-15','2026-07-19',{ballroom:false,boardroom:true,executive_suite:true,salon:false}),
      Status:            'approved',
      _source:           'booked',
    },
    // Weekend wedding same week — triple compression
    {
      Account_Name:      'Harmon–Park Wedding',
      Event_Type:        'Wedding/Social',
      Market_Segment:    'Social',
      Arrival_Date:      '2026-07-17',
      Departure_Date:    '2026-07-19',
      Nights:            2,
      Peak_Room_Block:   42,
      Attendees:         150,
      Forecasted_Occupancy: 0.95,
      Quoted_ADR:        189,
      Has_Meeting_Space: true,
      Uses_Ballroom:     true,
      Uses_Boardroom:    false,
      Num_Meeting_Rooms: 1,
      room_days: makeRoomDays('2026-07-17','2026-07-19',{ballroom:true,boardroom:false,executive_suite:false,salon:true}),
      Status:            'approved',
      _source:           'booked',
    },

    // ── AUGUST 2026 — MODERATE DEMAND ────────────────────────────────────────
    {
      Account_Name:      'Midwestern Financial Group Retreat',
      Event_Type:        'Corporate',
      Market_Segment:    'Finance',
      Arrival_Date:      '2026-08-03',
      Departure_Date:    '2026-08-06',
      Nights:            3,
      Peak_Room_Block:   70,
      Attendees:         85,
      Forecasted_Occupancy: 0.72,
      Quoted_ADR:        164,
      Has_Meeting_Space: true,
      Uses_Ballroom:     false,
      Uses_Boardroom:    true,
      Num_Meeting_Rooms: 2,
      Status:            'approved',
      _source:           'booked',
    },
    {
      Account_Name:      'Columbus Education Cooperative',
      Event_Type:        'Association',
      Market_Segment:    'Education',
      Arrival_Date:      '2026-08-24',
      Departure_Date:    '2026-08-27',
      Nights:            3,
      Peak_Room_Block:   55,
      Attendees:         120,
      Forecasted_Occupancy: 0.68,
      Quoted_ADR:        148,
      Has_Meeting_Space: true,
      Uses_Ballroom:     true,
      Uses_Boardroom:    false,
      Num_Meeting_Rooms: 2,
      Status:            'approved',
      _source:           'booked',
    },

    // ── SEPTEMBER 2026 — FALL COMPRESSION (Sept 21–26) ──────────────────────
    // Large association + corporate overlap creates a conflict scenario
    {
      Account_Name:      'Midwest Sales Leaders Forum',
      Event_Type:        'Association',
      Market_Segment:    'Professional Services',
      Arrival_Date:      '2026-09-21',
      Departure_Date:    '2026-09-24',
      Nights:            3,
      Peak_Room_Block:   130,
      Attendees:         155,
      Forecasted_Occupancy: 0.87,
      Quoted_ADR:        166,
      Has_Meeting_Space: true,
      Uses_Ballroom:     true,
      Uses_Boardroom:    false,
      Num_Meeting_Rooms: 3,
      room_days: makeRoomDays('2026-09-21','2026-09-24',{ballroom:true,boardroom:false,executive_suite:false,salon:true}),
      Status:            'approved',
      _source:           'booked',
    },
    {
      Account_Name:      'Ohio State Bar Foundation',
      Event_Type:        'Association',
      Market_Segment:    'Legal',
      Arrival_Date:      '2026-09-22',
      Departure_Date:    '2026-09-25',
      Nights:            3,
      Peak_Room_Block:   50,
      Attendees:         94,
      Forecasted_Occupancy: 0.91,
      Quoted_ADR:        158,
      Has_Meeting_Space: true,
      Uses_Ballroom:     false,
      Uses_Boardroom:    true,
      Num_Meeting_Rooms: 1,
      Status:            'approved',
      _source:           'booked',
    },

    // ── OCTOBER 2026 — PEAK FALL ─────────────────────────────────────────────
    {
      Account_Name:      'Marathon Classic Hospitality',
      Event_Type:        'Corporate',
      Market_Segment:    'Hospitality',
      Arrival_Date:      '2026-10-26',
      Departure_Date:    '2026-10-29',
      Nights:            3,
      Peak_Room_Block:   95,
      Attendees:         153,
      Forecasted_Occupancy: 0.78,
      Quoted_ADR:        171,
      Has_Meeting_Space: true,
      Uses_Ballroom:     true,
      Uses_Boardroom:    true,
      Num_Meeting_Rooms: 2,
      Status:            'approved',
      _source:           'booked',
    },
    {
      Account_Name:      'Rotary District Conference',
      Event_Type:        'Association',
      Market_Segment:    'Non-Profit',
      Arrival_Date:      '2026-10-13',
      Departure_Date:    '2026-10-16',
      Nights:            3,
      Peak_Room_Block:   140,
      Attendees:         243,
      Forecasted_Occupancy: 0.82,
      Quoted_ADR:        155,
      Has_Meeting_Space: true,
      Uses_Ballroom:     true,
      Uses_Boardroom:    false,
      Num_Meeting_Rooms: 4,
      Status:            'approved',
      _source:           'booked',
    },

    // ── NOVEMBER 2026 — QUIET PERIOD (pipeline hole) ─────────────────────────
    // Intentionally sparse to show a gap the hotel needs to fill
    {
      Account_Name:      'Veterans Entrepreneurs Network',
      Event_Type:        'Association',
      Market_Segment:    'Government',
      Arrival_Date:      '2026-11-16',
      Departure_Date:    '2026-11-19',
      Nights:            3,
      Peak_Room_Block:   40,
      Attendees:         78,
      Forecasted_Occupancy: 0.48,
      Quoted_ADR:        142,
      Has_Meeting_Space: true,
      Uses_Ballroom:     false,
      Uses_Boardroom:    true,
      Num_Meeting_Rooms: 1,
      Status:            'approved',
      _source:           'booked',
    },
  ];

  let count = 0;
  for (const event of events) {
    await addDoc(collection(db, 'booked_events'), {
      ...event,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    count++;
    console.log(`[seed] Added: ${event.Account_Name}`);
  }
  console.log(`[seed] Done — ${count} events added to booked_events`);
  return count;
}
