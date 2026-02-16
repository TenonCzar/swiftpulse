import { createClient } from "@libsql/client";

export default async function handler(request) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    const result = await client.execute(
      "SELECT * FROM parcels ORDER BY created_at DESC",
    );

    await client.close();

    return new Response(JSON.stringify(result.rows), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Database error" }), {
      status: 500,
    });
  }
}

export const config = { path: "/list-parcels" };
