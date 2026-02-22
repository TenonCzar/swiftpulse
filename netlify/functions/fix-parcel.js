// netlify/functions/fix-parcel.js
// One-off utility: re-geocodes and re-routes a parcel that was saved with null coordinates.
// POST /.netlify/functions/fix-parcel
// Body: { "trackingCode": "CRX-SGN-7XN-V1R" }
// DELETE THIS FILE once your parcels are all working.

const { initDb, ok, err, CORS_HEADERS } = require("./_db");
const { geocodeAddress, getRoute } = require("./_routing");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST") return err("POST only", 405);

  const { trackingCode } = JSON.parse(event.body || "{}");
  if (!trackingCode) return err("trackingCode required");

  const db = await initDb();

  const result = await db.execute({
    sql: "SELECT * FROM parcels WHERE tracking_code = ?",
    args: [trackingCode.toUpperCase()],
  });

  if (!result.rows.length) return err("Parcel not found", 404);
  const parcel = result.rows[0];

  console.log(`[fix-parcel] Geocoding for ${trackingCode}`);
  const [originGeo, destGeo] = await Promise.all([
    geocodeAddress(parcel.delivery_from_address),
    geocodeAddress(parcel.receiver_address),
  ]);

  if (!originGeo || !destGeo) {
    return err(
      `Geocoding failed. origin=${JSON.stringify(originGeo)} dest=${JSON.stringify(destGeo)}`,
      500,
    );
  }

  const routeData = await getRoute(
    originGeo.lat,
    originGeo.lng,
    destGeo.lat,
    destGeo.lng,
  );
  if (!routeData) return err("Routing failed", 500);

  await db.execute({
    sql: `UPDATE parcels SET
            origin_lat = ?, origin_lng = ?,
            destination_lat = ?, destination_lng = ?,
            current_lat = ?, current_lng = ?,
            current_location_name = 'Awaiting Pickup',
            route_points = ?, route_progress = 0,
            status = 'pending'
          WHERE tracking_code = ?`,
    args: [
      originGeo.lat,
      originGeo.lng,
      destGeo.lat,
      destGeo.lng,
      originGeo.lat,
      originGeo.lng,
      JSON.stringify(routeData.points),
      trackingCode.toUpperCase(),
    ],
  });

  return ok({
    success: true,
    trackingCode,
    origin: originGeo,
    destination: destGeo,
    routePoints: routeData.points.length,
    distanceKm: Math.round(routeData.distanceMeters / 1000),
  });
};
