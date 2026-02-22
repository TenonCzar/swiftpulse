// netlify/functions/_db.js
// Shared TursoDB client — imported by all functions.
// Netlify bundles each function independently via esbuild,
// so this module is inlined into each function bundle.

const { createClient } = require("@libsql/client/client-http");

let _client = null;

function getDb() {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url || !authToken) {
      throw new Error(
        "Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variables. " +
          "Add them in Netlify → Site Settings → Environment Variables.",
      );
    }

    _client = createClient({ url, authToken });
  }
  return _client;
}

async function initDb() {
  const db = getDb();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS parcels (
      id TEXT PRIMARY KEY,
      tracking_code TEXT UNIQUE NOT NULL,
      sender_name TEXT NOT NULL,
      sender_email TEXT,
      sender_address TEXT NOT NULL,
      receiver_name TEXT NOT NULL,
      receiver_email TEXT NOT NULL,
      receiver_address TEXT NOT NULL,
      parcel_description TEXT NOT NULL,
      delivery_from_address TEXT NOT NULL,
      days_to_deliver INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      current_lat REAL,
      current_lng REAL,
      current_location_name TEXT DEFAULT 'Awaiting Pickup',
      origin_lat REAL,
      origin_lng REAL,
      destination_lat REAL,
      destination_lng REAL,
      route_points TEXT,
      route_progress INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      estimated_delivery TEXT,
      last_updated TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tracking_events (
      id TEXT PRIMARY KEY,
      tracking_code TEXT NOT NULL,
      event_type TEXT NOT NULL,
      description TEXT NOT NULL,
      location_name TEXT,
      lat REAL,
      lng REAL,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tracking_code) REFERENCES parcels(tracking_code)
    )
  `);

  return db;
}

// Standard CORS headers for all function responses
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function ok(body, status = 200) {
  return {
    statusCode: status,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

function err(message, status = 400) {
  return {
    statusCode: status,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

module.exports = { getDb, initDb, ok, err, CORS_HEADERS };
