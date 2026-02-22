// netlify/functions/create-parcel.js
// Handles POST /api/parcels
// Called via the redirect in netlify.toml:
//   /api/parcels  →  /.netlify/functions/create-parcel

const { v4: uuidv4 } = require("uuid");
const { initDb, ok, err, CORS_HEADERS } = require("./_db");
const { geocodeAddress, getRoute } = require("./_routing");
const nodemailer  = require("nodemailer");

function generateTrackingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ1234567890";
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

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: `"SwiftPulse Courier" <${process.env.SMTP_USER}>`,
      to: receiverEmail,
      subject: `Your parcel is on its way — ${trackingCode}`,
      html: `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#F59E0B;">📦 Parcel Incoming, ${receiverName}!</h2>
      <p>A parcel has been sent to you and is now registered in our system.</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:8px;color:#888;width:160px;">Tracking Code</td><td style="padding:8px;font-weight:bold;letter-spacing:0.1em;">${trackingCode}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px;color:#888;">Description</td><td style="padding:8px;">${parcelDescription}</td></tr>
        <tr><td style="padding:8px;color:#888;">From</td><td style="padding:8px;">${senderName}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px;color:#888;">Delivery To</td><td style="padding:8px;">${receiverAddress}</td></tr>
        <tr><td style="padding:8px;color:#888;">Est. Delivery</td><td style="padding:8px;">${estimatedDelivery.toDateString()}</td></tr>
      </table>
      <a href="${process.env.SITE_URL}/track/${trackingCode}"
         style="display:inline-block;background:#F59E0B;color:#000;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px;">
        Track Your Parcel
      </a>
      <p style="color:#aaa;font-size:12px;margin-top:32px;">SwiftPulse Courier · Powered by CRX</p>
    </div>
  `,
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
