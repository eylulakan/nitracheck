import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getDatabase, ref, onValue
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

/*
  NitraCheck map dashboard
  - Firebase Realtime Database is the live source.
  - The parser intentionally accepts several common field names so the
    dashboard can work while the firmware field names are being finalized.
*/

// Modül seviyesinde yakalanmayan HERHANGİ bir hata (ör. bir CDN script'inin
// yüklenememesi), önceden sessizce tüm haritayı boş bırakıyordu — kullanıcı
// hiçbir uyarı görmüyordu. Artık böyle bir durumda en azından "HARİTA
// DURUMU" kutusunda hatayı gösteriyoruz ki teşhis kolaylaşsın.
window.addEventListener("error", (e) => {
  console.error("[NitraCheck] Yakalanmamış hata:", e.error || e.message);
  const el = document.getElementById("mapStatus");
  if (el) el.textContent = `Hata: ${e.message}`;
});

const TURKEY_CENTER = [39.0, 35.2];
const TURKEY_ZOOM = 5.6;
const SAFE_LIMIT = 50;
const HIGH_LIMIT = 100;

const map = L.map("map", {
  zoomControl: true,
  minZoom: 4.5,
  maxZoom: 14,
  scrollWheelZoom: true
}).setView(TURKEY_CENTER, TURKEY_ZOOM);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Aynı/çok yakın koordinatlardaki (ör. tek bir test noktasında art arda
// alınan ölçümler) marker'lar üst üste binip birbirini gizlemesin diye
// kümeleme (clustering) katmanı kullanılıyor. Yakınlaşınca otomatik açılır.
//
// ÖNEMLİ: leaflet.markercluster script'i CDN'den (unpkg) yüklenemezse
// (yavaş bağlantı, engelleyici, CDN kesintisi) L.markerClusterGroup
// tanımsız kalır ve bu satır bir hata fırlatırdı. Bu hata modül en üst
// seviyede fırlatıldığı için, dosyanın geri kalanı (Firebase bağlantısı
// dahil) HİÇ ÇALIŞMAZ ve haritada sessizce hiçbir şey görünmez. Bu yüzden
// burada güvenli bir fallback var: cluster kütüphanesi yoksa sıradan bir
// L.layerGroup kullanılır (kümeleme olmadan, ama veriler yine de görünür).
const clusterGroup = (typeof L.markerClusterGroup === "function")
  ? L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false
    })
  : (() => {
      console.error("[NitraCheck] leaflet.markercluster yüklenemedi, kümeleme olmadan devam ediliyor.");
      return L.layerGroup();
    })();
map.addLayer(clusterGroup);

const markers = new Map();
let allMeasurements = [];

const els = {
  totalCount: document.getElementById("totalCount"),
  safeCount: document.getElementById("safeCount"),
  highCount: document.getElementById("highCount"),
  connectionText: document.getElementById("connectionText"),
  lastUpdated: document.getElementById("lastUpdated"),
  lastMeasurement: document.getElementById("lastMeasurement"),
  mapStatus: document.getElementById("mapStatus"),
  sampleDevice: document.getElementById("sampleDevice"),
  samplePpm: document.getElementById("samplePpm"),
  sampleStatus: document.getElementById("sampleStatus"),
  locateBtn: document.getElementById("locateBtn")
};

function numberFrom(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null && obj[key] !== "") {
      const n = Number(obj[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function stringFrom(obj, keys, fallback = "—") {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null && String(obj[key]).trim() !== "") {
      return String(obj[key]);
    }
  }
  return fallback;
}

function normalizeReading(raw, id = "") {
  // location/nitrate may be flat on raw, or nested under raw.location / raw.nitrate
  const loc = (raw?.location && typeof raw.location === "object") ? raw.location : raw;
  const nit = (raw?.nitrate && typeof raw.nitrate === "object") ? raw.nitrate : raw;

  const lat = numberFrom(loc, ["latitude", "lat", "gpsLat", "GPS_LAT", "konumLat"]);
  const lng = numberFrom(loc, ["longitude", "lng", "lon", "gpsLng", "GPS_LNG", "konumLng"]);
  const ppm = numberFrom(nit, ["ppm", "nitrate", "nitratePpm", "NO3", "no3", "nitrat", "nitratPpm"]);
  if (lat === null || lng === null || ppm === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const device = stringFrom(raw, ["deviceId", "deviceID", "device", "cihazId", "id"], id || "NITRACHECK");
  const city = stringFrom(raw, ["city", "il", "locationName", "address"], "—");
  const timestamp = raw.timestamp ?? raw.time ?? raw.createdAt ?? raw.tarih ?? Date.now();
  const score = numberFrom(raw, ["ndsc8", "NDSC8", "ndscScore", "score"]);
  const opticalQuality = stringFrom(raw, ["opticalQuality", "quality", "optikKalite"], "—");

  return { id, lat, lng, ppm, device, city, timestamp, score, opticalQuality, raw };
}

function statusFor(ppm) {
  if (ppm <= SAFE_LIMIT) return { label: "GÜVENLİ", color: "#43e27a", className: "green" };
  if (ppm <= HIGH_LIMIT) return { label: "YÜKSEK", color: "#ffad3d", className: "orange" };
  return { label: "ÇOK YÜKSEK", color: "#ff4d55", className: "red" };
}

function toEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value; // örn. ISO string ise Date'e olduğu gibi bırak
  // Cihaz zaman damgasını EPOCH SANİYE olarak yazıyor (ör. 1788942995),
  // JS Date ise milisaniye bekler. 13 haneden kısa (< 1e12) değerleri
  // saniye kabul edip 1000 ile çarpıyoruz; yoksa tüm tarihler "1970" gibi
  // yanlış görünürdü.
  return n < 1e12 ? n * 1000 : n;
}

function formatDate(value) {
  const d = new Date(toEpochMs(value));
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium", timeStyle: "short"
  }).format(d);
}

function popupHtml(r) {
  const s = statusFor(r.ppm);
  return `
    <div class="popup-title">${escapeHtml(r.device)}</div>
    <div class="popup-ppm" style="color:${s.color}">${r.ppm.toFixed(1)} <small>mg/L NO₃⁻</small></div>
    <div class="status" style="color:${s.color}">
      <span class="status-dot" style="background:${s.color}"></span>${s.label}
    </div>
    <div class="popup-meta">
      ${escapeHtml(r.city)}<br>
      ${formatDate(r.timestamp)}<br>
      GPS: ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}
      ${r.score === null ? "" : `<br>NDSC-8: ${r.score.toFixed(4)}`}
    </div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function updateMarker(r) {
  const s = statusFor(r.ppm);
  const icon = L.divIcon({
    className: "",
    html: `<div class="custom-dot" style="background:${s.color};color:${s.color}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -8]
  });

  const marker = L.marker([r.lat, r.lng], { icon })
    .bindPopup(popupHtml(r), { maxWidth: 320 });
  clusterGroup.addLayer(marker);
  markers.set(r.id, marker);
}

function render(readings) {
  allMeasurements = readings.filter(Boolean).sort(
    (a, b) => Number(b.timestamp) - Number(a.timestamp)
  );

  const safe = allMeasurements.filter(r => r.ppm <= SAFE_LIMIT).length;
  const high = allMeasurements.filter(r => r.ppm > SAFE_LIMIT).length;

  els.totalCount.textContent = allMeasurements.length;
  els.safeCount.textContent = safe;
  els.highCount.textContent = high;
  els.mapStatus.textContent = `${allMeasurements.length} ölçüm noktası`;

  // Basitlik ve güvenilirlik için her güncellemede kümeleme katmanı
  // tamamen sıfırlanıp mevcut ölçümlerle yeniden kuruluyor.
  clusterGroup.clearLayers();
  markers.clear();
  allMeasurements.forEach(updateMarker);

  const latest = allMeasurements[0];
  if (latest) showLatest(latest);
}

function showLatest(r) {
  const s = statusFor(r.ppm);
  els.lastUpdated.textContent = formatDate(r.timestamp);
  els.lastMeasurement.innerHTML = `
    <div class="measurement-card">
      <div class="ppm" style="color:${s.color}">${r.ppm.toFixed(1)}</div>
      <div class="unit">mg/L NO₃⁻</div>
      <div class="status" style="color:${s.color}">
        <span class="status-dot" style="background:${s.color}"></span>${s.label}
      </div>
      <div class="detail-grid">
        <div class="detail"><span>CİHAZ</span><strong>${escapeHtml(r.device)}</strong></div>
        <div class="detail"><span>KONUM</span><strong>${escapeHtml(r.city)}</strong></div>
        <div class="detail"><span>GPS</span><strong>${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</strong></div>
        <div class="detail"><span>NDSC-8 SKORU</span><strong>${r.score === null ? "—" : r.score.toFixed(4)}</strong></div>
        <div class="detail"><span>OPTİK KALİTE</span><strong>${escapeHtml(r.opticalQuality)}</strong></div>
      </div>
    </div>`;
  els.sampleDevice.textContent = r.device;
  els.samplePpm.textContent = `${r.ppm.toFixed(1)} mg/L`;
  els.sampleStatus.textContent = s.label;
}

function startFirebase() {
  if (!firebaseConfig?.apiKey || !firebaseConfig?.databaseURL) {
    els.connectionText.textContent = "FIREBASE AYARLANMADI";
    els.mapStatus.textContent = "Demo veri kullanılabilir";
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);
    const readingsRef = ref(db, "measurements");

    onValue(readingsRef, snapshot => {
      const value = snapshot.val() || {};
      const rows = [];

      // Supports /readings/{id}: {...} and nested /readings/{device}/{id}: {...}
      function walk(node, path = []) {
        if (!node || typeof node !== "object") return;
        const normalized = normalizeReading(node, path.join("/"));
        if (normalized) {
          rows.push(normalized);
          return;
        }
        for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
      }
      walk(value);

      // Teşhis için: konsolda her zaman kaç ham kayıt geldiğini ve
      // bunlardan kaçının geçerli (lat/lng/ppm'i olan) bir ölçüme
      // dönüştüğünü göster. Örn. "Firebase: 72 ham kayıt, 33 haritalanabilir"
      const hamKayitSayisi = Object.keys(value).length;
      console.log(`[NitraCheck] Firebase: ${hamKayitSayisi} ham kayıt, ${rows.length} haritalanabilir (lat/lng içeren).`);

      els.connectionText.textContent = "FIREBASE · CANLI";
      if (rows.length === 0 && hamKayitSayisi > 0) {
        els.mapStatus.textContent = `${hamKayitSayisi} kayıt var ama hiçbirinde konum (latitude/longitude) yok`;
      }
      render(rows);
    }, error => {
      // "permission_denied" burada en sık görülen hata: Firebase
      // Realtime Database güvenlik kurallarında /measurements okuma
      // izni kapalıysa veri hiç gelmez ve harita boş kalır.
      console.error("[NitraCheck] Firebase onValue hatası:", error?.code || error);
      els.connectionText.textContent = "FIREBASE HATASI";
      els.mapStatus.textContent = error?.code === "PERMISSION_DENIED"
        ? "Okuma izni yok — Firebase güvenlik kurallarını kontrol edin"
        : "Veri okunamadı";
    });
  } catch (error) {
    console.error("[NitraCheck] Firebase başlatma hatası:", error);
    els.connectionText.textContent = "BAĞLANTI HATASI";
    els.mapStatus.textContent = String(error?.message || error);
  }
}

els.locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("Bu cihaz GPS/konum özelliğini desteklemiyor.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 12);
      L.circleMarker([latitude, longitude], {
        radius: 8, color: "#39e7d4", fillColor: "#39e7d4", fillOpacity: .9
      }).addTo(map).bindPopup("Mevcut konumunuz").openPopup();
    },
    () => alert("Konum izni alınamadı.")
  );
});

startFirebase();
