/**
 * location.ts — place names, the browser geolocation prompt, and the shared time model.
 *
 * The gazetteer is hand-authored (no network lookup): enough cities that "nearest city"
 * is usually within a degree or two, and enough that a name in the search box lands you
 * somewhere plausible. Coordinates are WGS84, taken from the commonly published values
 * for each city centre; they are labels for the observer, not survey data.
 */

export interface Place {
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** elevation, metres above sea level — used for the horizon dip of the observer */
  elev: number;
}

export const CITIES: Place[] = [
  { name: "Zürich", country: "CH", lat: 47.3769, lon: 8.5417, elev: 408 },
  { name: "Scuol", country: "CH", lat: 46.7955, lon: 10.2975, elev: 1290 },
  { name: "Bern", country: "CH", lat: 46.948, lon: 7.4474, elev: 542 },
  { name: "Genève", country: "CH", lat: 46.2044, lon: 6.1432, elev: 375 },
  { name: "Lugano", country: "CH", lat: 46.0037, lon: 8.9511, elev: 273 },
  { name: "Chur", country: "CH", lat: 46.851, lon: 9.532, elev: 594 },
  { name: "Basel", country: "CH", lat: 47.5596, lon: 7.5886, elev: 258 },
  { name: "Davos", country: "CH", lat: 46.8027, lon: 9.836, elev: 1560 },
  { name: "Berlin", country: "DE", lat: 52.52, lon: 13.405, elev: 34 },
  { name: "München", country: "DE", lat: 48.1351, lon: 11.582, elev: 519 },
  { name: "Hamburg", country: "DE", lat: 53.5511, lon: 9.9937, elev: 6 },
  { name: "Wien", country: "AT", lat: 48.2082, lon: 16.3738, elev: 171 },
  { name: "Salzburg", country: "AT", lat: 47.8095, lon: 13.055, elev: 424 },
  { name: "Innsbruck", country: "AT", lat: 47.2692, lon: 11.4041, elev: 574 },
  { name: "Paris", country: "FR", lat: 48.8566, lon: 2.3522, elev: 35 },
  { name: "Nice", country: "FR", lat: 43.7102, lon: 7.262, elev: 10 },
  { name: "Milano", country: "IT", lat: 45.4642, lon: 9.19, elev: 120 },
  { name: "Roma", country: "IT", lat: 41.9028, lon: 12.4964, elev: 21 },
  { name: "Palermo", country: "IT", lat: 38.1157, lon: 13.3615, elev: 14 },
  { name: "Ljubljana", country: "SI", lat: 46.0569, lon: 14.5058, elev: 295 },
  { name: "Praha", country: "CZ", lat: 50.0755, lon: 14.4378, elev: 191 },
  { name: "Warszawa", country: "PL", lat: 52.2297, lon: 21.0122, elev: 77 },
  { name: "Budapest", country: "HU", lat: 47.4979, lon: 19.0402, elev: 102 },
  { name: "Kyiv", country: "UA", lat: 50.4501, lon: 30.5234, elev: 179 },
  { name: "Stockholm", country: "SE", lat: 59.3293, lon: 18.0686, elev: 28 },
  { name: "Oslo", country: "NO", lat: 59.9139, lon: 10.7522, elev: 23 },
  { name: "Tromsø", country: "NO", lat: 69.6492, lon: 18.9553, elev: 10 },
  { name: "Longyearbyen", country: "NO", lat: 78.2232, lon: 15.6265, elev: 28 },
  { name: "Helsinki", country: "FI", lat: 60.1699, lon: 24.9384, elev: 26 },
  { name: "Reykjavík", country: "IS", lat: 64.1466, lon: -21.9426, elev: 26 },
  { name: "Tórshavn", country: "FO", lat: 62.0078, lon: -6.7898, elev: 28 },
  { name: "London", country: "GB", lat: 51.5074, lon: -0.1278, elev: 11 },
  { name: "Edinburgh", country: "GB", lat: 55.9533, lon: -3.1883, elev: 47 },
  { name: "Dublin", country: "IE", lat: 53.3498, lon: -6.2603, elev: 20 },
  { name: "Lisboa", country: "PT", lat: 38.7223, lon: -9.1393, elev: 60 },
  { name: "Madrid", country: "ES", lat: 40.4168, lon: -3.7038, elev: 667 },
  { name: "Barcelona", country: "ES", lat: 41.3874, lon: 2.1686, elev: 12 },
  { name: "Palma", country: "ES", lat: 39.5696, lon: 2.6502, elev: 13 },
  { name: "Rabat", country: "MA", lat: 34.0209, lon: -6.8416, elev: 75 },
  { name: "Marrakech", country: "MA", lat: 31.6295, lon: -7.9811, elev: 466 },
  { name: "Casablanca", country: "MA", lat: 33.5731, lon: -7.5898, elev: 27 },
  { name: "Algiers", country: "DZ", lat: 36.7538, lon: 3.0588, elev: 24 },
  { name: "Tunis", country: "TN", lat: 36.8065, lon: 10.1815, elev: 4 },
  { name: "Tripoli", country: "LY", lat: 32.8872, lon: 13.1913, elev: 10 },
  { name: "Kairo", country: "EG", lat: 30.0444, lon: 31.2357, elev: 75 },
  { name: "Luxor", country: "EG", lat: 25.6872, lon: 32.6396, elev: 88 },
  { name: "Tel Aviv", country: "IL", lat: 32.0853, lon: 34.7818, elev: 20 },
  { name: "Amman", country: "JO", lat: 31.9539, lon: 35.9106, elev: 1000 },
  { name: "Petra", country: "JO", lat: 30.3285, lon: 35.4444, elev: 900 },
  { name: "Beirut", country: "LB", lat: 33.8938, lon: 35.5018, elev: 30 },
  { name: "Istanbul", country: "TR", lat: 41.0082, lon: 28.9784, elev: 39 },
  { name: "Ankara", country: "TR", lat: 39.9334, lon: 32.8597, elev: 938 },
  { name: "Antalya", country: "TR", lat: 36.8969, lon: 30.7133, elev: 30 },
  { name: "Tbilisi", country: "GE", lat: 41.7151, lon: 44.8271, elev: 418 },
  { name: "Yerevan", country: "AM", lat: 40.1792, lon: 44.4991, elev: 990 },
  { name: "Baku", country: "AZ", lat: 40.4093, lon: 49.8671, elev: -28 },
  { name: "Tehran", country: "IR", lat: 35.6892, lon: 51.389, elev: 1189 },
  { name: "Isfahan", country: "IR", lat: 32.6546, lon: 51.668, elev: 1574 },
  { name: "Baghdad", country: "IQ", lat: 33.3152, lon: 44.3661, elev: 34 },
  { name: "Riyadh", country: "SA", lat: 24.7136, lon: 46.6753, elev: 600 },
  { name: "Jeddah", country: "SA", lat: 21.4858, lon: 39.1925, elev: 12 },
  { name: "Dubai", country: "AE", lat: 25.2048, lon: 55.2708, elev: 5 },
  { name: "Muscat", country: "OM", lat: 23.588, lon: 58.3829, elev: 10 },
  { name: "Sanaa", country: "YE", lat: 15.3694, lon: 44.191, elev: 2250 },
  { name: "Karachi", country: "PK", lat: 24.8607, lon: 67.0011, elev: 8 },
  { name: "Lahore", country: "PK", lat: 31.5204, lon: 74.3587, elev: 217 },
  { name: "Islamabad", country: "PK", lat: 33.6844, lon: 73.0479, elev: 540 },
  { name: "Delhi", country: "IN", lat: 28.6139, lon: 77.209, elev: 216 },
  { name: "Mumbai", country: "IN", lat: 19.076, lon: 72.8777, elev: 14 },
  { name: "Bengaluru", country: "IN", lat: 12.9716, lon: 77.5946, elev: 920 },
  { name: "Chennai", country: "IN", lat: 13.0827, lon: 80.2707, elev: 6 },
  { name: "Kathmandu", country: "NP", lat: 27.7172, lon: 85.324, elev: 1400 },
  { name: "Lhasa", country: "CN", lat: 29.65, lon: 91.1409, elev: 3650 },
  { name: "Dhaka", country: "BD", lat: 23.8103, lon: 90.4125, elev: 4 },
  { name: "Yangon", country: "MM", lat: 16.8409, lon: 96.1735, elev: 17 },
  { name: "Bangkok", country: "TH", lat: 13.7563, lon: 100.5018, elev: 2 },
  { name: "Singapore", country: "SG", lat: 1.3521, lon: 103.8198, elev: 15 },
  { name: "Kuala Lumpur", country: "MY", lat: 3.139, lon: 101.6869, elev: 56 },
  { name: "Jakarta", country: "ID", lat: -6.2088, lon: 106.8456, elev: 8 },
  { name: "Denpasar", country: "ID", lat: -8.6705, lon: 115.2126, elev: 19 },
  { name: "Manila", country: "PH", lat: 14.5995, lon: 120.9842, elev: 16 },
  { name: "Ho Chi Minh City", country: "VN", lat: 10.8231, lon: 106.6297, elev: 19 },
  { name: "Hanoi", country: "VN", lat: 21.0278, lon: 105.8342, elev: 15 },
  { name: "Hong Kong", country: "HK", lat: 22.3193, lon: 114.1694, elev: 32 },
  { name: "Taipei", country: "TW", lat: 25.033, lon: 121.5654, elev: 7 },
  { name: "Shanghai", country: "CN", lat: 31.2304, lon: 121.4737, elev: 4 },
  { name: "Beijing", country: "CN", lat: 39.9042, lon: 116.4074, elev: 44 },
  { name: "Xi'an", country: "CN", lat: 34.3416, lon: 108.9398, elev: 405 },
  { name: "Ürümqi", country: "CN", lat: 43.8256, lon: 87.6168, elev: 800 },
  { name: "Seoul", country: "KR", lat: 37.5665, lon: 126.978, elev: 38 },
  { name: "Tokyo", country: "JP", lat: 35.6762, lon: 139.6503, elev: 40 },
  { name: "Osaka", country: "JP", lat: 34.6937, lon: 135.5023, elev: 13 },
  { name: "Sapporo", country: "JP", lat: 43.0618, lon: 141.3545, elev: 30 },
  { name: "Naha", country: "JP", lat: 26.2124, lon: 127.6809, elev: 9 },
  { name: "Vladivostok", country: "RU", lat: 43.1155, lon: 131.8855, elev: 12 },
  { name: "Novosibirsk", country: "RU", lat: 55.0084, lon: 82.9357, elev: 147 },
  { name: "Yekaterinburg", country: "RU", lat: 56.8389, lon: 60.6057, elev: 267 },
  { name: "Moskva", country: "RU", lat: 55.7558, lon: 37.6173, elev: 156 },
  { name: "Sankt Petersburg", country: "RU", lat: 59.9311, lon: 30.3609, elev: 3 },
  { name: "Mirnyy", country: "RU", lat: 62.5353, lon: 113.9611, elev: 300 },
  { name: "Perth", country: "AU", lat: -31.9505, lon: 115.8605, elev: 15 },
  { name: "Adelaide", country: "AU", lat: -34.9285, lon: 138.6007, elev: 49 },
  { name: "Melbourne", country: "AU", lat: -37.8136, lon: 144.9631, elev: 31 },
  { name: "Sydney", country: "AU", lat: -33.8688, lon: 151.2093, elev: 3 },
  { name: "Brisbane", country: "AU", lat: -27.4698, lon: 153.0251, elev: 14 },
  { name: "Darwin", country: "AU", lat: -12.4634, lon: 130.8456, elev: 30 },
  { name: "Alice Springs", country: "AU", lat: -23.698, lon: 133.8807, elev: 577 },
  { name: "Wellington", country: "NZ", lat: -41.2866, lon: 174.7756, elev: 31 },
  { name: "Christchurch", country: "NZ", lat: -43.532, lon: 172.6306, elev: 21 },
  { name: "Auckland", country: "NZ", lat: -36.8485, lon: 174.7633, elev: 7 },
  { name: "Suva", country: "FJ", lat: -18.1416, lon: 178.4419, elev: 40 },
  { name: "Papeete", country: "PF", lat: -17.535, lon: -149.5696, elev: 4 },
  { name: "Honolulu", country: "US", lat: 21.3069, lon: -157.8583, elev: 6 },
  { name: "Anchorage", country: "US", lat: 61.2181, lon: -149.9003, elev: 31 },
  { name: "Fairbanks", country: "US", lat: 64.8378, lon: -147.7164, elev: 136 },
  { name: "Seattle", country: "US", lat: 47.6062, lon: -122.3321, elev: 56 },
  { name: "San Francisco", country: "US", lat: 37.7749, lon: -122.4194, elev: 16 },
  { name: "Los Angeles", country: "US", lat: 34.0522, lon: -118.2437, elev: 71 },
  { name: "Las Vegas", country: "US", lat: 36.1699, lon: -115.1398, elev: 610 },
  { name: "Phoenix", country: "US", lat: 33.4484, lon: -112.074, elev: 331 },
  { name: "Denver", country: "US", lat: 39.7392, lon: -104.9903, elev: 1609 },
  { name: "Albuquerque", country: "US", lat: 35.0844, lon: -106.6504, elev: 1619 },
  { name: "Chicago", country: "US", lat: 41.8781, lon: -87.6298, elev: 181 },
  { name: "Houston", country: "US", lat: 29.7604, lon: -95.3698, elev: 13 },
  { name: "New York", country: "US", lat: 40.7128, lon: -74.006, elev: 10 },
  { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589, elev: 43 },
  { name: "Miami", country: "US", lat: 25.7617, lon: -80.1918, elev: 2 },
  { name: "Atlanta", country: "US", lat: 33.749, lon: -84.388, elev: 320 },
  { name: "Toronto", country: "CA", lat: 43.6532, lon: -79.3832, elev: 76 },
  { name: "Montréal", country: "CA", lat: 45.5019, lon: -73.5674, elev: 38 },
  { name: "Vancouver", country: "CA", lat: 49.2827, lon: -123.1207, elev: 70 },
  { name: "Calgary", country: "CA", lat: 51.0447, lon: -114.0719, elev: 1045 },
  { name: "Ottawa", country: "CA", lat: 45.4215, lon: -75.6972, elev: 74 },
  { name: "Winnipeg", country: "CA", lat: 49.8951, lon: -97.1384, elev: 231 },
  { name: "Yellowknife", country: "CA", lat: 62.454, lon: -114.3718, elev: 206 },
  { name: "Iqaluit", country: "CA", lat: 63.7467, lon: -68.517, elev: 34 },
  { name: "Nuuk", country: "GL", lat: 64.1814, lon: -51.6941, elev: 9 },
  { name: "Mexico City", country: "MX", lat: 19.4326, lon: -99.1332, elev: 2240 },
  { name: "Guadalajara", country: "MX", lat: 20.6597, lon: -103.3496, elev: 1566 },
  { name: "Guatemala City", country: "GT", lat: 14.6349, lon: -90.5069, elev: 1490 },
  { name: "San José", country: "CR", lat: 9.9281, lon: -84.0907, elev: 1172 },
  { name: "Panama City", country: "PA", lat: 8.9824, lon: -79.5199, elev: 10 },
  { name: "Havana", country: "CU", lat: 23.1136, lon: -82.3666, elev: 59 },
  { name: "Bogotá", country: "CO", lat: 4.711, lon: -74.0721, elev: 2640 },
  { name: "Caracas", country: "VE", lat: 10.4806, lon: -66.9036, elev: 916 },
  { name: "Quito", country: "EC", lat: -0.1807, lon: -78.4678, elev: 2850 },
  { name: "Lima", country: "PE", lat: -12.0464, lon: -77.0428, elev: 79 },
  { name: "Cusco", country: "PE", lat: -13.532, lon: -71.9675, elev: 3399 },
  { name: "La Paz", country: "BO", lat: -16.5, lon: -68.15, elev: 3640 },
  { name: "Santiago", country: "CL", lat: -33.4489, lon: -70.6693, elev: 570 },
  { name: "Buenos Aires", country: "AR", lat: -34.6037, lon: -58.3816, elev: 25 },
  { name: "Córdoba", country: "AR", lat: -31.4201, lon: -64.1888, elev: 392 },
  { name: "Mendoza", country: "AR", lat: -32.8895, lon: -68.8458, elev: 813 },
  { name: "Ushuaia", country: "AR", lat: -54.8019, lon: -68.303, elev: 6 },
  { name: "Montevideo", country: "UY", lat: -34.9011, lon: -56.1645, elev: 43 },
  { name: "São Paulo", country: "BR", lat: -23.5505, lon: -46.6333, elev: 760 },
  { name: "Rio de Janeiro", country: "BR", lat: -22.9068, lon: -43.1729, elev: 2 },
  { name: "Brasília", country: "BR", lat: -15.7975, lon: -47.8919, elev: 1079 },
  { name: "Fortaleza", country: "BR", lat: -3.7319, lon: -38.5267, elev: 21 },
  { name: "Cayenne", country: "GF", lat: 4.9224, lon: -52.3134, elev: 8 },
  { name: "Dakar", country: "SN", lat: 14.7167, lon: -17.4677, elev: 14 },
  { name: "Bamako", country: "ML", lat: 12.6392, lon: -8.0029, elev: 341 },
  { name: "Accra", country: "GH", lat: 5.6037, lon: -0.187, elev: 21 },
  { name: "Lagos", country: "NG", lat: 6.5244, lon: 3.3792, elev: 41 },
  { name: "Abuja", country: "NG", lat: 9.0765, lon: 7.3986, elev: 477 },
  { name: "Niamey", country: "NE", lat: 13.5137, lon: 2.1098, elev: 211 },
  { name: "N'Djamena", country: "TD", lat: 12.1348, lon: 15.0557, elev: 293 },
  { name: "Khartoum", country: "SD", lat: 15.5007, lon: 32.5599, elev: 385 },
  { name: "Addis Ababa", country: "ET", lat: 9.032, lon: 38.7469, elev: 2355 },
  { name: "Nairobi", country: "KE", lat: -1.2921, lon: 36.8219, elev: 1795 },
  { name: "Kampala", country: "UG", lat: 0.3476, lon: 32.5825, elev: 1190 },
  { name: "Kigali", country: "RW", lat: -1.9403, lon: 30.0618, elev: 1567 },
  { name: "Dar es Salaam", country: "TZ", lat: -6.7924, lon: 39.2083, elev: 55 },
  { name: "Antananarivo", country: "MG", lat: -18.8792, lon: 47.5079, elev: 1263 },
  { name: "Windhoek", country: "NA", lat: -22.5609, lon: 17.0658, elev: 1721 },
  { name: "Luanda", country: "AO", lat: -8.839, lon: 13.2894, elev: 5 },
  { name: "Johannesburg", country: "ZA", lat: -26.2041, lon: 28.0473, elev: 1753 },
  { name: "Cape Town", country: "ZA", lat: -33.9249, lon: 18.4241, elev: 25 },
  { name: "Gaborone", country: "BW", lat: -24.6544, lon: 25.9091, elev: 1001 },
  { name: "Harare", country: "ZW", lat: -17.8252, lon: 31.0335, elev: 1490 },
  { name: "Telupid", country: "MY", lat: 5.3833, lon: 116.6333, elev: 200 },
  { name: "Kuching", country: "MY", lat: 1.5533, lon: 110.3442, elev: 16 },
  { name: "Bandar Seri Begawan", country: "BN", lat: 4.9031, lon: 114.9398, elev: 12 },
  { name: "Brasília de Minas", country: "BR", lat: -14.2461, lon: -44.965, elev: 794 },
  { name: "Atacama", country: "CL", lat: -27.5, lon: -70.5, elev: 1200 },
  { name: "Mauna Kea", country: "US", lat: 19.8207, lon: -155.4681, elev: 4207 },
  { name: "Paranal", country: "CL", lat: -24.6275, lon: -70.4044, elev: 2635 },
  { name: "Svalbard SG1", country: "NO", lat: 78.2297, lon: 15.4077, elev: 400 },
  { name: "South Pole", country: "AQ", lat: -90, lon: 0, elev: 2835 },
  { name: "McMurdo", country: "AQ", lat: -77.8419, lon: 166.6863, elev: 24 },
];

/** Great-circle distance in km (spherical Earth, good enough for "nearest city"). */
export function distanceKm(a: Place | { lat: number; lon: number }, b: Place | { lat: number; lon: number }): number {
  const d2r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d2r;
  const dLon = (b.lon - a.lon) * d2r;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Closest gazetteer entry, used to name a position from geolocation or a map click. */
export function nearestPlace(lat: number, lon: number): { place: Place; km: number } {
  const from = { lat, lon };
  let best = CITIES[0]!;
  let km = Infinity;
  for (const c of CITIES) {
    const d = distanceKm(from, c);
    if (d < km) {
      km = d;
      best = c;
    }
  }
  return { place: best, km };
}

/** Browser geolocation, one-shot. Rejects with a human-readable reason. */
export function askBrowserLocation(): Promise<{ lat: number; lon: number; elev: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("This browser has no geolocation."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, elev: pos.coords.altitude ?? 0 }),
      (err) => reject(new Error(`Geolocation unavailable (${err.code}): ${err.message}`)),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  });
}

// ------------------------------------------------------- wall-time model

export type TimeMode = "site" | "browser" | "utc";

/**
 * UTC instant → wall-clock parts in the chosen mode.
 *
 * `site` is mean solar time at the observer's longitude (15° = 1 h), which is what a
 * sundial-and-horizon sky map reads in; no political zone offsets are involved.
 */
export function utcToWall(date: Date, mode: TimeMode): { parts: number[]; label: string } {
  if (mode === "utc") {
    return {
      parts: [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()],
      label: "UTC",
    };
  }
  if (mode === "browser") {
    return {
      parts: [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()],
      label: "local",
    };
  }
  const ms = date.getTime() + siteOffsetMs(date);
  const d = new Date(ms);
  return {
    parts: [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()],
    label: "site",
  };
}

/** Wall-clock parts → UTC instant, in the chosen mode. */
export function wallToUtc(parts: number[], mode: TimeMode): Date {
  const [y, mo, d, h, mi] = parts.map((n) => Math.round(n));
  if (mode === "utc") return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!));
  if (mode === "browser") return new Date(y!, mo! - 1, d!, h!, mi!);
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!) - siteOffsetMs(new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!))));
}

/** Mean solar offset from UTC at a longitude, in ms (15° = 1 h, DST never applies). */
export function siteOffsetMs(date: Date, lonDeg?: number): number {
  const lon = lonDeg ?? CURRENT_LON;
  return Math.round((lon / 15) * 3600000 / 60000) * 60000;
}

/** Longitude used by `site` mode; kept in sync by main.ts. */
export let CURRENT_LON = 8.5417;
export function setCurrentLon(lon: number) {
  CURRENT_LON = lon;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Fold a proper name for matching: case, accents and the letters that Unicode does not
 * decompose (ø, æ, ß, đ, ł …) all collapse, and punctuation becomes spaces. Chosen so
 * "Zurich", "Zürich", "Tromso" and "Tromsø" reach the same gazetteer entry.
 */
const TRANSLITERATE: [RegExp, string][] = [
  [/ø/g, "o"],
  [/Ø/g, "O"],
  [/æ/g, "ae"],
  [/Æ/g, "AE"],
  [/ß/g, "ss"],
  [/đ|ð/g, "d"],
  [/Đ|Ð/g, "D"],
  [/ł/g, "l"],
  [/Ł/g, "L"],
  [/þ/g, "th"],
  [/Þ/g, "TH"],
  [/ħ/g, "h"],
  [/ŋ/g, "n"],
  [/ı/g, "i"],
  [/ƒ/g, "f"],
  [/ŧ/g, "t"],
];

export function foldName(text: string): string {
  let out = text;
  for (const [re, value] of TRANSLITERATE) out = out.replace(re, value);
  return out
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `YYYY-MM-DDTHH:MM` for a <input type="datetime-local">, in the chosen mode. */
export function wallInputValue(date: Date, mode: TimeMode): string {
  const [y, mo, d, h, mi] = utcToWall(date, mode).parts;
  return `${y}-${pad2(mo!)}-${pad2(d!)}T${pad2(h!)}:${pad2(mi!)}`;
}

/** `HH:MM` of an instant in the display mode. */
export function formatClock(date: Date, mode: TimeMode): string {
  const { parts } = utcToWall(date, mode);
  return `${pad2(parts[3]!)}:${pad2(parts[4]!)}`;
}

/** `YYYY-MM-DD` of an instant in the display mode. */
export function formatDateWall(date: Date, mode: TimeMode): string {
  const { parts } = utcToWall(date, mode);
  return `${parts[0]}-${pad2(parts[1]!)}-${pad2(parts[2]!)}`;
}

/** Long-form wall time, e.g. `2026-10-15 21:34 site (UTC+00:52)`. */
export function formatWall(date: Date, mode: TimeMode, withSeconds = false): string {
  const { parts, label } = utcToWall(date, mode);
  const [y, mo, d, h, mi] = parts;
  const secs = withSeconds ? `:${pad2(date.getUTCSeconds())}` : "";
  const off = mode === "site" ? ` (UTC${formatOffset(siteOffsetMs(date) / 3600000)})` : mode === "utc" ? " (UTC+00:00)" : "";
  return `${y}-${pad2(mo!)}-${pad2(d!)} ${pad2(h!)}:${pad2(mi!)}${secs} ${label}${off}`;
}

export function formatOffset(hours: number): string {
  const sign = hours < 0 ? "-" : "+";
  const a = Math.abs(hours);
  return `${sign}${pad2(Math.floor(a))}:${pad2(Math.round((a % 1) * 60))}`;
}

/** `HH:MM` of an instant in the display mode, or `—` for a missing event. */
export function formatEventTime(date: Date | null, mode: TimeMode, mode2?: TimeMode): string {
  if (!date) return "—";
  const m = mode2 ?? mode;
  const { parts } = utcToWall(date, m);
  return `${pad2(parts[3]!)}:${pad2(parts[4]!)}`;
}

/** Date part only, so a rise/set table can show "tomorrow" honestly. */
export function formatEventDate(date: Date | null, mode: TimeMode): string {
  if (!date) return "";
  const { parts } = utcToWall(date, mode);
  return `${pad2(parts[1]!)}-${pad2(parts[2]!)}`;
}