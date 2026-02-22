// netlify/functions/update-locations.js
// Scheduled function — runs every hour (cron: "0 * * * *" set in netlify.toml).
// Advances each active parcel along its pre-computed route,
// reverse-geocodes the new position, and logs a tracking event.
//
// Netlify Scheduled Functions docs:
// https://docs.netlify.com/functions/scheduled-functions/

const { v4: uuidv4 } = require("uuid");
const { initDb } = require("./_db");
const { reverseGeocode } = require("./_routing");

exports.handler = async (event) => {
  // Netlify sends scheduled invocations as POST with a specific header.
  // During local dev you can POST to /.netlify/functions/update-locations manually.
  console.log(`[update-locations] Triggered at ${new Date().toISOString()}`);

  try {
    const db = await initDb();

    const result = await db.execute(`
      SELECT * FROM parcels
      WHERE status IN ('pending', 'in_transit', 'out_for_delivery')
        AND route_points IS NOT NULL
    `);

    if (!result.rows.length) {
      console.log("[update-locations] No active parcels.");
      return { statusCode: 200, body: JSON.stringify({ updated: 0 }) };
    }

    let updated = 0;

    for (const parcel of result.rows) {
      try {
        await advanceParcel(parcel, db);
        updated++;
        // Respect Nominatim's 1-req/sec rate limit
        await sleep(1100);
      } catch (e) {
        console.error(
          `[update-locations] Failed for ${parcel.tracking_code}:`,
          e.message,
        );
      }
    }

    console.log(
      `[update-locations] Done. Updated ${updated}/${result.rows.length} parcel(s).`,
    );
    return { statusCode: 200, body: JSON.stringify({ updated }) };
  } catch (e) {
    console.error("[update-locations] Fatal error:", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

async function advanceParcel(parcel, db) {
  const routePoints = JSON.parse(parcel.route_points);
  const totalPoints = routePoints.length;
  const totalHours = parcel.days_to_deliver * 24;
  const pointsPerHr = Math.max(1, Math.floor(totalPoints / totalHours));

  let newProgress = (parcel.route_progress || 0) + pointsPerHr;
  let newStatus = parcel.status;

  if (newProgress >= totalPoints - 1) {
    newProgress = totalPoints - 1;
    newStatus = "delivered";
  } else {
    if (parcel.status === "pending") newStatus = "in_transit";
    // Last 5% of route → out for delivery
    if (newProgress >= totalPoints * 0.95) newStatus = "out_for_delivery";
  }

  const point = routePoints[newProgress];
  const locationName = await reverseGeocode(point.lat, point.lng);

  await db.execute({
    sql: `UPDATE parcels
          SET current_lat = ?, current_lng = ?, current_location_name = ?,
              route_progress = ?, status = ?, last_updated = datetime('now')
          WHERE tracking_code = ?`,
    args: [
      point.lat,
      point.lng,
      locationName,
      newProgress,
      newStatus,
      parcel.tracking_code,
    ],
  });

  const isDelivered = newStatus === "delivered";
  const eventType = isDelivered ? "delivered" : "location_update";
  const description = isDelivered
    ? `Package delivered to ${parcel.receiver_name}`
    : `Package in transit through ${locationName}`;

  await db.execute({
    sql: `INSERT INTO tracking_events
            (id, tracking_code, event_type, description, location_name, lat, lng)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      uuidv4(),
      parcel.tracking_code,
      eventType,
      description,
      locationName,
      point.lat,
      point.lng,
    ],
  });

  console.log(
    `  ↪ ${parcel.tracking_code}: ${newProgress}/${totalPoints - 1} (${newStatus}) @ ${locationName}`,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
