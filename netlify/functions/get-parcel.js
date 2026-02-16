import { createClient } from "@libsql/client";

export default async function handler(request) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim().toUpperCase();

  if (!code || code.length !== 12) {
    return new Response(JSON.stringify({ error: "Invalid tracking code" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    const result = await client.execute({
      sql: "SELECT * FROM parcels WHERE tracking_code = ? LIMIT 1",
      args: [code],
    });

    await client.close();

    if (result.rows.length === 0) {
      return new Response(JSON.stringify({ error: "Parcel not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parcel = result.rows[0];

    return new Response(
      JSON.stringify({
        success: true,
        parcel: {
          trackingCode: parcel.tracking_code,
          senderName: parcel.sender_name,
          recipientName: parcel.recipient_name,
          description: parcel.description,
          status: parcel.status,
          createdAt: parcel.created_at,
          // add more fields as needed
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Database error" }), {
      status: 500,
    });
  }
}

export const config = { path: "/get-parcel" };
