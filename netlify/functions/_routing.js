// netlify/functions/_routing.js
// Geocoding  → Mapbox Geocoding API (free tier: 100k req/month)
// Routing    → OSRM public API (free, no key) with straight-line fallback
// Reverse    → Mapbox Reverse Geocoding

const MAPBOX = "https://api.mapbox.com/geocoding/v5/mapbox.places";
const OSRM = "https://router.project-osrm.org";

function mapboxToken() {
  const token = process.env.MAPBOX_TOKEN;
  if (!token)
    throw new Error("MAPBOX_TOKEN is not set in environment variables.");
  return token;
}

// ─── Forward geocoding ────────────────────────────────────────────────────────
async function geocodeAddress(address) {
  const token = mapboxToken();
  const url = `${MAPBOX}/${encodeURIComponent(address)}.json?access_token=${token}&limit=1`;
  console.log(`[geocode] Mapbox request for: "${address}"`);

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    console.log(`[geocode] Status: ${res.status}`);

    if (!res.ok) {
      console.error(`[geocode] Mapbox HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();

    if (!data.features?.length) {
      console.warn(`[geocode] No results for: "${address}"`);
      return null;
    }

    const [lng, lat] = data.features[0].center;
    const placeName = data.features[0].place_name;
    console.log(`[geocode] ✅ "${address}" → ${lat}, ${lng} (${placeName})`);
    return { lat, lng, placeName };
  } catch (e) {
    console.error(`[geocode] Exception: ${e.message}`);
    return null;
  }
}

// Tries full address, then without house number, then city-level
async function geocodeWithFallback(address) {
  let result = await geocodeAddress(address);
  if (result) return result;

  // Strip house number: "2559 Davis Lane" → "Davis Lane"
  const withoutNumber = address.replace(/^\d+\s+/, "");
  if (withoutNumber !== address) {
    console.log(`[geocode] Retrying without house number: "${withoutNumber}"`);
    result = await geocodeAddress(withoutNumber);
    if (result) return result;
  }

  // City-level fallback: last 2-3 comma segments
  const parts = address.split(",");
  if (parts.length >= 2) {
    const cityLevel = parts.slice(-3).join(",").trim();
    console.log(`[geocode] Retrying city-level: "${cityLevel}"`);
    result = await geocodeAddress(cityLevel);
    if (result) return result;
  }

  return null;
}

// ─── Routing ──────────────────────────────────────────────────────────────────
async function getRoute(oLat, oLng, dLat, dLng) {
  const url =
    `${OSRM}/route/v1/driving/${oLng},${oLat};${dLng},${dLat}` +
    `?overview=full&geometries=geojson`;
  console.log(`[route] OSRM request: ${oLat},${oLng} → ${dLat},${dLng}`);

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    console.log(`[route] OSRM status: ${res.status}`);

    if (res.ok) {
      const data = await res.json();
      if (data.routes?.length && data.code === "Ok") {
        const coords = data.routes[0].geometry.coordinates;
        const points = sampleCoords(coords, 100);
        console.log(
          `[route] ✅ OSRM: ${points.length} points, ${Math.round(data.routes[0].distance / 1000)}km`,
        );
        return { points, distanceMeters: data.routes[0].distance };
      }
      console.warn(
        `[route] OSRM no routes (code: ${data.code}) — using interpolation`,
      );
    } else {
      console.warn(`[route] OSRM HTTP ${res.status} — using interpolation`);
    }
  } catch (e) {
    console.warn(`[route] OSRM exception: ${e.message} — using interpolation`);
  }

  // Fallback: straight-line interpolation (handles ocean/international routes)
  return interpolatedRoute(oLat, oLng, dLat, dLng);
}

function interpolatedRoute(oLat, oLng, dLat, dLng) {
  const steps = 100;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      lat: oLat + (dLat - oLat) * t,
      lng: oLng + (dLng - oLng) * t,
    });
  }
  const R = 6371000;
  const φ1 = (oLat * Math.PI) / 180,
    φ2 = (dLat * Math.PI) / 180;
  const Δφ = ((dLat - oLat) * Math.PI) / 180;
  const Δλ = ((dLng - oLng) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const distanceMeters = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  console.log(
    `[route] ✅ Interpolated: ${points.length} points, ~${Math.round(distanceMeters / 1000)}km`,
  );
  return { points, distanceMeters };
}

function sampleCoords(coords, max) {
  if (coords.length <= max) return coords.map(([lng, lat]) => ({ lat, lng }));
  const step = Math.floor(coords.length / max);
  const out = [];
  for (let i = 0; i < coords.length; i += step)
    out.push({ lat: coords[i][1], lng: coords[i][0] });
  const last = coords[coords.length - 1];
  if (out[out.length - 1].lng !== last[0])
    out.push({ lat: last[1], lng: last[0] });
  return out;
}

// ─── Reverse geocoding ────────────────────────────────────────────────────────
async function reverseGeocode(lat, lng) {
  try {
    const token = mapboxToken();
    const url = `${MAPBOX}/${lng},${lat}.json?access_token=${token}&limit=1&types=place,locality,neighborhood,address`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });

    if (!res.ok) return "In transit";

    const data = await res.json();
    if (!data.features?.length) return "In transit";

    // Return the shortest meaningful place name
    const feature = data.features[0];
    const context = feature.context || [];

    const city = context.find((c) => c.id.startsWith("place"))?.text;
    const country = context.find((c) => c.id.startsWith("country"))?.text;
    const name = feature.text;

    return (
      [name, city || country].filter(Boolean).join(", ") ||
      feature.place_name?.split(",")[0] ||
      "In transit"
    );
  } catch {
    return "In transit";
  }
}

module.exports = {
  geocodeAddress,
  geocodeWithFallback,
  getRoute,
  reverseGeocode,
};
