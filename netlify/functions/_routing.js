// netlify/functions/_routing.js
// Geocoding via OpenStreetMap Nominatim (free, no key).
// Routing via OSRM public API (free, no key).

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OSRM = "https://router.project-osrm.org";
const UA = "CRXCourierApp/1.0 (contact@crxcourier.com)";

async function geocodeAddress(address) {
  try {
    const res = await fetch(
      `${NOMINATIM}/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
}

async function getRoute(oLat, oLng, dLat, dLng) {
  try {
    const url =
      `${OSRM}/route/v1/driving/${oLng},${oLat};${dLng},${dLat}` +
      `?overview=full&geometries=geojson`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.routes?.length) return null;

    const coords = data.routes[0].geometry.coordinates; // [lng, lat]
    const points = sampleCoords(coords, 100);
    return { points, distanceMeters: data.routes[0].distance };
  } catch {
    return null;
  }
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
