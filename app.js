```javascript
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getDatabase, ref, onValue
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

/*
  NitraCheck map dashboard

  SADECE YENİ NitraCheck43001-... KAYITLARI KULLANILIR.

  Firebase'deki eski:
    device_c39fc114_...

  kayıtları gösterilmez.

  Yeni kayıt örneği:
    id: "NitraCheck43001-000003"
    ppm: 64.4455
    ndscSkoru: 0.28118
    optikKalite: 99.9343
    timestamp: 1788944280

  Sınıflandırma:
    <= 50 mg/L       -> GÜVENLİ
    > 50 <= 100      -> YÜKSEK
    > 100            -> ÇOK YÜKSEK
*/

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

// Marker clustering
const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 40,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false
});

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


/* =========================================================
   YARDIMCI FONKSİYONLAR
   ========================================================= */

function numberFrom(obj, keys) {
  for (const key of keys) {
    if (
      obj?.[key] !== undefined &&
      obj?.[key] !== null &&
      obj[key] !== ""
    ) {
      const n = Number(obj[key]);

      if (Number.isFinite(n)) {
        return n;
      }
    }
  }

  return null;
}


function stringFrom(obj, keys, fallback = "—") {
  for (const key of keys) {
    if (
      obj?.[key] !== undefined &&
      obj?.[key] !== null &&
      String(obj[key]).trim() !== ""
    ) {
      return String(obj[key]);
    }
  }

  return fallback;
}


/* =========================================================
   SADECE YENİ KAYITLARI KABUL ET
   ========================================================= */

function isNewNitraCheckMeasurement(raw, id = "") {

  const possibleIds = [
    id,
    raw?.id,
    raw?.measurementId,
    raw?.measurementID
  ];

  return possibleIds.some(value =>
    typeof value === "string" &&
    value.startsWith("NitraCheck43001-")
  );
}


/* =========================================================
   ÖLÇÜMÜ NORMALİZE ET
   ========================================================= */

function normalizeReading(raw, id = "") {

  // SADECE yeni NitraCheck43001-... kayıtları
  if (!isNewNitraCheckMeasurement(raw, id)) {
    return null;
  }

  const loc =
    (raw?.location && typeof raw.location === "object")
      ? raw.location
      : raw;

  const nit =
    (raw?.nitrate && typeof raw.nitrate === "object")
      ? raw.nitrate
      : raw;


  /* GPS */

  const lat = numberFrom(loc, [
    "latitude",
    "lat",
    "gpsLat",
    "GPS_LAT",
    "konumLat"
  ]);

  const lng = numberFrom(loc, [
    "longitude",
    "lng",
    "lon",
    "gpsLng",
    "GPS_LNG",
    "konumLng"
  ]);


  /* NİTRAT */

  const ppm = numberFrom(nit, [
    "ppm",
    "nitrate",
    "nitratePpm",
    "NO3",
    "no3",
    "nitrat",
    "nitratPpm"
  ]);

  // PPM yoksa ölçüm geçersiz
  if (ppm === null) {
    return null;
  }


  /* CİHAZ */

  const device = stringFrom(raw, [
    "deviceId",
    "deviceID",
    "device",
    "cihazId"
  ], "NITRACHECK");


  /*
    Yeni Firebase kaydında ID zaten:

      NitraCheck43001-000003

    şeklinde geliyor.
  */

  const measurementId =
    stringFrom(raw, [
      "id",
      "measurementId",
      "measurementID"
    ], id || "NitraCheck43001");


  /* KONUM */

  const city = stringFrom(raw, [
    "city",
    "il",
    "locationName",
    "address"
  ], "—");


  /* ZAMAN */

  const timestamp =
    raw.timestamp ??
    raw.time ??
    raw.createdAt ??
    raw.tarih ??
    Date.now();


  /* NDSC-8 */

  const score = numberFrom(raw, [
    "ndscSkoru",
    "ndsc8",
    "NDSC8",
    "ndscScore",
    "score"
  ]);


  /* OPTİK KALİTE */

  const opticalQuality = stringFrom(raw, [
    "optikKalite",
    "opticalQuality",
    "quality"
  ], "—");


  return {
    id: measurementId,
    lat,
    lng,
    ppm,
    device,
    city,
    timestamp,
    score,
    opticalQuality,
    raw
  };
}


/* =========================================================
   DURUM SINIFLANDIRMASI
   ========================================================= */

function statusFor(ppm) {

  if (ppm <= SAFE_LIMIT) {
    return {
      label: "GÜVENLİ",
      color: "#43e27a",
      className: "green"
    };
  }

  if (ppm <= HIGH_LIMIT) {
    return {
      label: "YÜKSEK",
      color: "#ffad3d",
      className: "orange"
    };
  }

  return {
    label: "ÇOK YÜKSEK",
    color: "#ff4d55",
    className: "red"
  };
}


/* =========================================================
   TARİH
   ========================================================= */

function formatDate(value) {

  let numericValue = Number(value);

  /*
    Firebase timestamp saniye cinsindeyse JavaScript Date
    milisaniye beklediği için x1000 yapılır.
  */

  if (Number.isFinite(numericValue)) {

    // Unix timestamp saniye seviyesindeyse
    if (numericValue > 1000000000 && numericValue < 10000000000) {
      numericValue *= 1000;
    }
  }

  const d = new Date(
    Number.isFinite(numericValue)
      ? numericValue
      : value
  );

  if (Number.isNaN(d.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(d);
}


/* =========================================================
   POPUP
   ========================================================= */

function popupHtml(r) {

  const s = statusFor(r.ppm);

  const gpsText =
    r.lat !== null && r.lng !== null
      ? `GPS: ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`
      : "GPS: Konum bilgisi yok";

  return `
    <div class="popup-title">${escapeHtml(r.device)}</div>

    <div class="popup-ppm" style="color:${s.color}">
      ${r.ppm.toFixed(1)}
      <small>mg/L NO₃⁻</small>
    </div>

    <div class="status" style="color:${s.color}">
      <span class="status-dot" style="background:${s.color}"></span>
      ${s.label}
    </div>

    <div class="popup-meta">
      ${escapeHtml(r.city)}<br>
      ${formatDate(r.timestamp)}<br>
      ${gpsText}
      ${r.score === null
        ? ""
        : `<br>NDSC-8: ${r.score.toFixed(4)}`}
      ${r.opticalQuality === "—"
        ? ""
        : `<br>Optik Kalite: ${escapeHtml(r.opticalQuality)}`}
    </div>
  `;
}


/* =========================================================
   HTML GÜVENLİĞİ
   ========================================================= */

function escapeHtml(value) {

  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}


/* =========================================================
   MARKER
   ========================================================= */

function updateMarker(r) {

  /*
    GPS yoksa marker oluşturma.
    Böylece sahte bir Türkiye konumu oluşmaz.
  */

  if (
    r.lat === null ||
    r.lng === null ||
    !Number.isFinite(r.lat) ||
    !Number.isFinite(r.lng)
  ) {
    return;
  }

  const s = statusFor(r.ppm);

  const icon = L.divIcon({
    className: "",
    html: `
      <div
        class="custom-dot"
        style="background:${s.color};color:${s.color}">
      </div>
    `,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -8]
  });

  const marker = L.marker(
    [r.lat, r.lng],
    { icon }
  ).bindPopup(
    popupHtml(r),
    { maxWidth: 320 }
  );

  clusterGroup.addLayer(marker);
  markers.set(r.id, marker);
}


/* =========================================================
   EKRANI RENDER ET
   ========================================================= */

function render(readings) {

  allMeasurements = readings
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(b.timestamp) -
        Number(a.timestamp)
    );


  /* SINIFLAR */

  const safe =
    allMeasurements.filter(
      r => r.ppm <= SAFE_LIMIT
    ).length;

  const high =
    allMeasurements.filter(
      r =>
        r.ppm > SAFE_LIMIT &&
        r.ppm <= HIGH_LIMIT
    ).length;

  const veryHigh =
    allMeasurements.filter(
      r => r.ppm > HIGH_LIMIT
    ).length;


  /* ÜST İSTATİSTİKLER */

  els.totalCount.textContent =
    allMeasurements.length;

  els.safeCount.textContent =
    safe;

  /*
    HTML'de üçüncü ayrı sayaç bulunmadığı için
    mevcut "YÜKSEK" alanı burada Yüksek + Çok Yüksek
    toplamını gösteriyor.
  */

  els.highCount.textContent =
    high + veryHigh;


  els.mapStatus.textContent =
    `${allMeasurements.length} ölçüm noktası`;


  /* HARİTA */

  clusterGroup.clearLayers();
  markers.clear();

  allMeasurements.forEach(updateMarker);


  /* SON ÖLÇÜM */

  const latest = allMeasurements[0];

  if (latest) {
    showLatest(latest);
  }
}


/* =========================================================
   SON ÖLÇÜM
   ========================================================= */

function showLatest(r) {

  const s = statusFor(r.ppm);

  els.lastUpdated.textContent =
    formatDate(r.timestamp);


  els.lastMeasurement.innerHTML = `
    <div class="measurement-card">

      <div class="ppm" style="color:${s.color}">
        ${r.ppm.toFixed(1)}
      </div>

      <div class="unit">
        mg/L NO₃⁻
      </div>

      <div class="status" style="color:${s.color}">
        <span
          class="status-dot"
          style="background:${s.color}">
        </span>
        ${s.label}
      </div>

      <div class="detail-grid">

        <div class="detail">
          <span>CİHAZ</span>
          <strong>
            ${escapeHtml(r.device)}
          </strong>
        </div>

        <div class="detail">
          <span>ÖLÇÜM ID</span>
          <strong>
            ${escapeHtml(r.id)}
          </strong>
        </div>

        <div class="detail">
          <span>KONUM</span>
          <strong>
            ${escapeHtml(r.city)}
          </strong>
        </div>

        <div class="detail">
          <span>GPS</span>
          <strong>
            ${
              r.lat !== null && r.lng !== null
                ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`
                : "Konum yok"
            }
          </strong>
        </div>

        <div class="detail">
          <span>NDSC-8 SKORU</span>
          <strong>
            ${
              r.score === null
                ? "—"
                : r.score.toFixed(4)
            }
          </strong>
        </div>

        <div class="detail">
          <span>OPTİK KALİTE</span>
          <strong>
            ${escapeHtml(r.opticalQuality)}
          </strong>
        </div>

      </div>
    </div>
  `;


  els.sampleDevice.textContent =
    r.device;

  els.samplePpm.textContent =
    `${r.ppm.toFixed(1)} mg/L`;

  els.sampleStatus.textContent =
    s.label;
}


/* =========================================================
   FIREBASE
   ========================================================= */

function startFirebase() {

  if (
    !firebaseConfig?.apiKey ||
    !firebaseConfig?.databaseURL
  ) {
    els.connectionText.textContent =
      "FIREBASE AYARLANMADI";

    els.mapStatus.textContent =
      "Demo veri kullanılabilir";

    return;
  }


  try {

    const app =
      initializeApp(firebaseConfig);

    const db =
      getDatabase(app);


    /*
      Kökten okuyoruz.

      Böylece yeni NitraCheck43001-... kayıtları
      /measurements altında olmasa bile bulunabilir.

      Eski kayıtlar normalizeReading() tarafından
      NitraCheck43001-... olmadığı için atılır.
    */

    const rootRef =
      ref(db, "/");


    onValue(
      rootRef,

      snapshot => {

        const value =
          snapshot.val() || {};

        const rows = [];


        /*
          Firebase ağacının tamamını dolaş.

          Sadece NitraCheck43001-... ID'li kayıtları
          normalizeReading() kabul edecek.
        */

        function walk(node, path = []) {

          if (
            node === null ||
            typeof node !== "object"
          ) {
            return;
          }


          const currentId =
            path.length
              ? path[path.length - 1]
              : "";


          const normalized =
            normalizeReading(
              node,
              currentId
            );


          if (normalized) {

            rows.push(normalized);

            /*
              Bu kayıt bulundu.
              Alt alanları tekrar ölçüm olarak
              taramaya gerek yok.
            */

            return;
          }


          for (
            const [key, child]
            of Object.entries(node)
          ) {

            walk(
              child,
              [...path, key]
            );
          }
        }


        walk(value);


        /*
          Aynı ölçüm birden fazla path'ten
          bulunursa ID'ye göre tekilleştir.
        */

        const unique =
          new Map();

        rows.forEach(r => {
          unique.set(r.id, r);
        });


        const finalRows =
          Array.from(unique.values());


        els.connectionText.textContent =
          "FIREBASE · CANLI";


        render(finalRows);

      },

      error => {

        console.error(
          "Firebase okuma hatası:",
          error
        );

        els.connectionText.textContent =
          "FIREBASE HATASI";

        els.mapStatus.textContent =
          "Veri okunamadı";
      }
    );

  } catch (error) {

    console.error(
      "Firebase bağlantı hatası:",
      error
    );

    els.connectionText.textContent =
      "BAĞLANTI HATASI";
  }
}


/* =========================================================
   KONUMUMU BUL
   ========================================================= */

els.locateBtn.addEventListener(
  "click",
  () => {

    if (!navigator.geolocation) {

      alert(
        "Bu cihaz GPS/konum özelliğini desteklemiyor."
      );

      return;
    }


    navigator.geolocation.getCurrentPosition(

      pos => {

        const {
          latitude,
          longitude
        } = pos.coords;


        map.setView(
          [latitude, longitude],
          12
        );


        L.circleMarker(
          [latitude, longitude],
          {
            radius: 8,
            color: "#39e7d4",
            fillColor: "#39e7d4",
            fillOpacity: .9
          }
        )
        .addTo(map)
        .bindPopup(
          "Mevcut konumunuz"
        )
        .openPopup();
      },

      () =>
        alert(
          "Konum izni alınamadı."
        )
    );
  }
);


/* =========================================================
   BAŞLAT
   ========================================================= */

startFirebase();
```
