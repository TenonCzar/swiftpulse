// Netlify function — runs on serverless Node.js
import { createClient } from "@libsql/client";

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const body = await request.json();

    // Basic validation
    if (!body.senderName || !body.recipientName || !body.description) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    // Generate 12-letter uppercase tracking code (A-Z)
    const trackingCode = Array.from({ length: 12 }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26)),
    ).join("");

    // You can add more checks (unique code) later

    const result = await client.execute({
      sql: `
        INSERT INTO parcels (
          tracking_code,
          sender_name, sender_phone, sender_address,
          recipient_name, recipient_phone, recipient_address,
          description, weight_kg, value_naira,
          shipping_method, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
      `,
      args: [
        trackingCode,
        body.senderName,
        body.senderPhone || "",
        body.senderAddress || "",
        body.recipientName,
        body.recipientPhone || "",
        body.recipientAddress || "",
        body.description,
        body.weight || 0,
        body.value || 0,
        body.shippingMethod || "standard",
      ],
    });

    await client.close();

    return new Response(
      JSON.stringify({
        success: true,
        trackingCode,
        id: result.lastInsertRowid,
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Database error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const config = { path: "/create-parcel" };
