# NitraCheck Türkiye Web Platformu

Responsive NitraCheck dashboard:
- Türkiye merkezli Leaflet haritası
- Firebase Realtime Database canlı ölçümleri
- GPS koordinatlı renkli nitrat noktaları
- Noktaya tıklayınca cihaz / ppm / GPS / NDSC-8 bilgisi
- Telefon, tablet ve masaüstü uyumlu
- NDSC-8 hesaplama zinciri açıklaması

## 1. Firebase
`firebase-config.js` içindeki alanları kendi Firebase Web App yapılandırmanızla doldurun.

Firebase Realtime Database yolunun:
`/readings/`

olması beklenir.

Örnek kayıt:
{
  "deviceId": "NC-43001",
  "latitude": 38.3552,
  "longitude": 27.1287,
  "city": "İzmir",
  "ppm": 18.4,
  "ndsc8": 0.1234,
  "timestamp": 1786600000000,
  "opticalQuality": "OK"
}

Kod ayrıca lat/lng, nitrate/nitratePpm, no3/nitrat gibi yaygın alan adlarını da tanır.

## 2. Netlify
Repository köküne şu dosyaları koyun:
- index.html
- style.css
- app.js
- firebase-config.js

Build command: boş
Publish directory: `.`

GitHub'a push edildiğinde Netlify bağlı repository üzerinden yeni deploy oluşturur.
