// netlify/functions/create-parcel.js
// Handles POST /api/parcels
// Called via the redirect in netlify.toml:
//   /api/parcels  →  /.netlify/functions/create-parcel

const { v4: uuidv4 } = require("uuid");
const { initDb, ok, err, CORS_HEADERS } = require("./_db");
const { geocodeAddress, getRoute } = require("./_routing");

function generateTrackingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let seg = () =>
    Array.from(
      { length: 3 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
  return `CRX-${seg()}-${seg()}-${seg()}`;
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return err("Method not allowed", 405);
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return err("Invalid JSON body", 400);
  }

  const {
    senderName,
    senderEmail,
    senderAddress,
    receiverName,
    receiverEmail,
    receiverAddress,
    parcelDescription,
    deliveryFromAddress,
    daysToDeliver,
  } = body;

  // Validate required fields
  const required = {
    senderName,
    senderAddress,
    receiverName,
    receiverEmail,
    receiverAddress,
    parcelDescription,
    deliveryFromAddress,
    daysToDeliver,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length)
    return err(`Missing required fields: ${missing.join(", ")}`);

  const days = parseInt(daysToDeliver, 10);
  if (isNaN(days) || days < 1 || days > 30)
    return err("daysToDeliver must be between 1 and 30");

  try {
    const db = await initDb();
    const trackingCode = generateTrackingCode();
    const id = uuidv4();

    // Geocode both addresses in parallel
    const [originGeo, destGeo] = await Promise.all([
      geocodeAddress(deliveryFromAddress),
      geocodeAddress(receiverAddress),
    ]);

    let originLat = null,
      originLng = null;
    let destLat = null,
      destLng = null;
    let routePointsJson = null;
    let routeAvailable = false;

    if (originGeo && destGeo) {
      ({ lat: originLat, lng: originLng } = originGeo);
      ({ lat: destLat, lng: destLng } = destGeo);

      const routeData = await getRoute(originLat, originLng, destLat, destLng);
      if (routeData) {
        routePointsJson = JSON.stringify(routeData.points);
        routeAvailable = true;
      }
    }

    const estimatedDelivery = new Date();
    estimatedDelivery.setDate(estimatedDelivery.getDate() + days);

    await db.execute({
      sql: `INSERT INTO parcels
              (id, tracking_code, sender_name, sender_email, sender_address,
               receiver_name, receiver_email, receiver_address, parcel_description,
               delivery_from_address, days_to_deliver, status,
               current_lat, current_lng, current_location_name,
               origin_lat, origin_lng, destination_lat, destination_lng,
               route_points, route_progress, estimated_delivery)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        trackingCode,
        senderName,
        senderEmail || null,
        senderAddress,
        receiverName,
        receiverEmail,
        receiverAddress,
        parcelDescription,
        deliveryFromAddress,
        days,
        "pending",
        originLat,
        originLng,
        "Awaiting Pickup",
        originLat,
        originLng,
        destLat,
        destLng,
        routePointsJson,
        0,
        estimatedDelivery.toISOString(),
      ],
    });

    await db.execute({
      sql: `INSERT INTO tracking_events
              (id, tracking_code, event_type, description, location_name, lat, lng)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        uuidv4(),
        trackingCode,
        "created",
        `Parcel registered. Awaiting pickup from ${deliveryFromAddress}`,
        deliveryFromAddress,
        originLat,
        originLng,
      ],
    });

    return ok(
      {
        success: true,
        trackingCode,
        estimatedDelivery: estimatedDelivery.toISOString(),
        routeAvailable,
        message: "Parcel created successfully",
      },
      201,
    );
  } catch (e) {
    console.error("[create-parcel]", e);
    return err("Failed to create parcel. Please try again.", 500);
  }
};
