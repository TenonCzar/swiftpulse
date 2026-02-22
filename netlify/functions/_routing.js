// netlify/functions/_routing.js
// Geocoding via OpenStreetMap Nominatim (free, no key).
// Routing via OSRM public API (free, no key).

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OSRM = "https://router.project-osrm.org";
const UA = "CRXCourierApp/1.0 (contact@crxcourier.com)";

async function geocodeAddress(address) {
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  console.log(`[geocode] Requesting: ${url}`);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });

    console.log(`[geocode] Status: ${res.status} for "${address}"`);

    if (!res.ok) {
      console.error(`[geocode] HTTP ${res.status} for "${address}"`);
      return null;
    }

    const data = await res.json();
    console.log(
      `[geocode] Results for "${address}":`,
      JSON.stringify(data.slice(0, 1)),
    );

    if (!data.length) {
      console.warn(`[geocode] No results for: "${address}"`);
      return null;
    }

    const result = {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
    };
    console.log(`[geocode] ✅ "${address}" → ${result.lat}, ${result.lng}`);
    return result;
  } catch (e) {
    console.error(`[geocode] Exception for "${address}":`, e.message);
    return null;
  }
}

async function getRoute(oLat, oLng, dLat, dLng) {
  // OSRM can't route across oceans — for international shipments
  // we fall back to a straight-line interpolated route
  const url = `${OSRM}/route/v1/driving/${oLng},${oLat};${dLng},${dLat}?overview=full&geometries=geojson`;
  console.log(`[route] Requesting OSRM: ${url}`);

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    console.log(`[route] OSRM status: ${res.status}`);

    if (res.ok) {
      const data = await res.json();
      if (data.routes?.length && data.code === "Ok") {
        const coords = data.routes[0].geometry.coordinates;
        const points = sampleCoords(coords, 100);
        console.log(
          `[route] ✅ OSRM route found: ${points.length} points, ${data.routes[0].distance}m`,
        );
        return { points, distanceMeters: data.routes[0].distance };
      }
      console.warn(
        `[route] OSRM returned no routes (code: ${data.code}) — falling back to interpolated`,
      );
    } else {
      console.warn(
        `[route] OSRM HTTP ${res.status} — falling back to interpolated`,
      );
    }
  } catch (e) {
    console.warn(
      `[route] OSRM exception: ${e.message} — falling back to interpolated`,
    );
  }

  // Fallback: straight-line interpolation (works for international/ocean routes)
  console.log(`[route] Using interpolated straight-line route`);
  return interpolatedRoute(oLat, oLng, dLat, dLng);
}

// Generates 100 evenly-spaced points between origin and destination
// Good enough for tracking simulation when OSRM can't find a road route
function interpolatedRoute(oLat, oLng, dLat, dLng) {
  const points = [];
  const steps = 100;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      lat: oLat + (dLat - oLat) * t,
      lng: oLng + (dLng - oLng) * t,
    });
  }
  // Approximate distance using Haversine
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

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `${NOMINATIM}/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
    );
    if (!res.ok) return "In transit";
    const data = await res.json();
    const a = data.address || {};
    return (
      [a.road || a.pedestrian, a.city || a.town || a.village || a.county]
        .filter(Boolean)
        .slice(0, 2)
        .join(", ") || "In transit"
    );
  } catch {
    return "In transit";
  }
}

module.exports = { geocodeAddress, getRoute, reverseGeocode };
