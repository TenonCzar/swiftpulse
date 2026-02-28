// netlify/functions/update-locations.js
// Scheduled — runs every hour via cron: "0 * * * *" in netlify.toml
//
// Movement logic:
//   - Route is stored as N sampled points (default 100)
//   - Total journey = days_to_deliver * 24 hours
//   - Each hour we advance (N / totalHours) points along the route
//   - Progress is always relative to time elapsed since creation,
//     so parcels that were created days ago catch up correctly
//   - Status: pending → in_transit → out_for_delivery (last 5%) → delivered

const { v4: uuidv4 } = require("uuid");
const { initDb } = require("./_db");
const { reverseGeocode } = require("./_routing");

exports.handler = async (event) => {
  console.log(`[update-locations] Triggered at ${new Date().toISOString()}`);

  try {
    const db = await initDb();

    const result = await db.execute(`
      SELECT * FROM parcels
      WHERE status IN ('pending', 'in_transit', 'out_for_delivery')
        AND route_points IS NOT NULL
        AND origin_lat IS NOT NULL
    `);

    if (!result.rows.length) {
      console.log("[update-locations] No active parcels to update.");
      return { statusCode: 200, body: JSON.stringify({ updated: 0 }) };
    }

    console.log(
      `[update-locations] Processing ${result.rows.length} parcel(s)...`,
    );
    let updated = 0;

    for (const parcel of result.rows) {
      try {
        await advanceParcel(parcel, db);
        updated++;
        // Mapbox reverse geocoding has no strict rate limit but be polite
        await sleep(300);
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

  // Calculate how many hours have elapsed since the parcel was created
  const createdAt = new Date(parcel.created_at);
  const now = new Date();
  const hoursElapsed = Math.max(0, (now - createdAt) / (1000 * 60 * 60));

  // Target index = what point we SHOULD be at right now based on time elapsed
  // This self-corrects: if a parcel was created 10hrs ago on a 72hr journey,
  // it will jump to the correct position regardless of prior update history
  const targetProgress = Math.min(
    totalPoints - 1,
    Math.floor((hoursElapsed / totalHours) * (totalPoints - 1)),
  );

  // Only advance, never go backwards
  const newProgress = Math.max(parcel.route_progress || 0, targetProgress);

  // Determine status
  let newStatus = parcel.status;
  if (newProgress >= totalPoints - 1) {
    newStatus = "delivered";
  } else if (newProgress >= totalPoints * 0.95) {
    newStatus = "out_for_delivery";
  } else if (parcel.status === "pending") {
    newStatus = "in_transit";
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

  // Log tracking event
  const isDelivered = newStatus === "delivered";
  await db.execute({
    sql: `INSERT INTO tracking_events
            (id, tracking_code, event_type, description, location_name, lat, lng)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      uuidv4(),
      parcel.tracking_code,
      isDelivered ? "delivered" : "location_update",
      isDelivered
        ? `Package delivered to ${parcel.receiver_name}`
        : `Package in transit through ${locationName}`,
      locationName,
      point.lat,
      point.lng,
    ],
  });

  const pct = Math.round((newProgress / (totalPoints - 1)) * 100);
  console.log(
    `  ↪ ${parcel.tracking_code}: ${newProgress}/${totalPoints - 1} (${pct}%) ` +
      `[${newStatus}] @ ${locationName} | elapsed: ${hoursElapsed.toFixed(1)}h / ${totalHours}h`,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
