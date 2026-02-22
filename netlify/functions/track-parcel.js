// netlify/functions/track-parcel.js
// Handles GET /api/track/:code
// The redirect rule passes :code as a path segment; Netlify also
// exposes it in event.path so we parse it from there.

const { initDb, ok, err, CORS_HEADERS } = require("./_db");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return err("Method not allowed", 405);
  }

  // Extract tracking code from the path
  // event.path will be something like /.netlify/functions/track-parcel/CRX-ABC-DEF-GHI
  // or /api/track/CRX-ABC-DEF-GHI (before rewrite)
  const segments = (event.path || "").split("/").filter(Boolean);
  const code = segments[segments.length - 1]?.toUpperCase();

  if (!code || !code.startsWith("CRX-")) {
    return err("Invalid or missing tracking code", 400);
  }

  try {
    const db = await initDb();

    const parcelResult = await db.execute({
      sql: "SELECT * FROM parcels WHERE tracking_code = ?",
      args: [code],
    });

    if (!parcelResult.rows.length) {
      return err("Tracking code not found", 404);
    }

    const parcel = parcelResult.rows[0];

    const eventsResult = await db.execute({
      sql: "SELECT * FROM tracking_events WHERE tracking_code = ? ORDER BY timestamp DESC LIMIT 20",
      args: [code],
    });

    // Thin out route points for payload efficiency (every 5th point)
    let routePoints = null;
    if (parcel.route_points) {
      const pts = JSON.parse(parcel.route_points);
      routePoints = pts.filter((_, i) => i % 5 === 0 || i === pts.length - 1);
    }

    let progressPercent = 0;
    if (parcel.route_points && parcel.route_progress != null) {
      const total = JSON.parse(parcel.route_points).length;
      progressPercent = Math.round(
        (parcel.route_progress / Math.max(total - 1, 1)) * 100,
      );
    }

    return ok({
      parcel: {
        trackingCode: parcel.tracking_code,
        status: parcel.status,
        senderName: parcel.sender_name,
        senderAddress: parcel.sender_address,
        receiverName: parcel.receiver_name,
        receiverAddress: parcel.receiver_address,
        parcelDescription: parcel.parcel_description,
        currentLat: parcel.current_lat,
        currentLng: parcel.current_lng,
        currentLocationName: parcel.current_location_name,
        originLat: parcel.origin_lat,
        originLng: parcel.origin_lng,
        destinationLat: parcel.destination_lat,
        destinationLng: parcel.destination_lng,
        daysToDeliver: parcel.days_to_deliver,
        estimatedDelivery: parcel.estimated_delivery,
        createdAt: parcel.created_at,
        lastUpdated: parcel.last_updated,
        progressPercent,
      },
      routePoints,
      events: eventsResult.rows,
    });
  } catch (e) {
    console.error("[track-parcel]", e);
    return err("Failed to fetch tracking info", 500);
  }
};
