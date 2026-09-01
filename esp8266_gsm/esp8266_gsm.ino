#define TINY_GSM_MODEM_SIM800
#include <SoftwareSerial.h>
#include <TinyGsmClient.h>
#include <PubSubClient.h>
#include <TinyGPSPlus.h>

// ============================================================
// HARDWARE & VEHICLE CONFIGURATION
// ============================================================
const char* ROUTE_ID          = "77A_NOBATA";
const char* BUS_PLATE         = "WB42U2676";
const char* APN               = "bsnlnet";
const char* GPRS_USER         = "";
const char* GPRS_PASS         = "";

const char* MQTT_BROKER       = "broker.hivemq.com";
const int   MQTT_PORT         = 1883;
const char* MQTT_TOPIC        = "citytransit/fleet/77a_nobata/wb42u2676/data";

// Leave blank ("") so the web app's 4-tier engine handles direction automatically
const char* TRIP_DIRECTION    = ""; 

// Adaptive Transmission Intervals (Throttled when stationary to save 2G buffer)
const unsigned long MOVING_INTERVAL_MS     = 3000;  // 3s while moving
const unsigned long STATIONARY_INTERVAL_MS = 8000;  // 8s when stationary
const unsigned long RECONNECT_INTERVAL_MS  = 5000;  // 5s between broker retry attempts
// ============================================================

// SoftwareSerial for SIM800L (RX=D2/GPIO4, TX=D1/GPIO5)
SoftwareSerial gsmSerial(4, 5);
TinyGsm modem(gsmSerial);
TinyGsmClient gsmClient(modem);
PubSubClient mqttClient(gsmClient);

// SoftwareSerial for GPS (RX=D5/GPIO14 -> GPS TX, TX=D6/GPIO12 -> GPS RX)
SoftwareSerial gpsSerial(14, 12);
TinyGPSPlus gps;

const int GSM_RESET_PIN = 13; // D7
unsigned long lastSendTime = 0;
unsigned long lastReconnectAttempt = 0;
float lastKnownHeading = 0.0;

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(GSM_RESET_PIN, OUTPUT);
  digitalWrite(GSM_RESET_PIN, HIGH);

  gsmSerial.begin(9600);
  gpsSerial.begin(9600);
  gpsSerial.listen();

  Serial.println(F("\n--- Starting Scalable Fleet Tracker (Stable & Automated) ---"));

  // Hardware Reset SIM800L on startup
  digitalWrite(GSM_RESET_PIN, LOW);
  delay(1000);
  digitalWrite(GSM_RESET_PIN, HIGH);
  delay(3000);

  gsmSerial.listen();
  modem.init();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setBufferSize(256);
  mqttClient.setKeepAlive(30);     // 30s keepalive ping to maintain open socket over 2G
  mqttClient.setSocketTimeout(10); // 10s timeout allowance for slow carrier handoffs
}

void loop() {
  // 1. Continuous background GPS decoding
  gpsSerial.listen();
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

  // 2. Network & MQTT session management
  gsmSerial.listen();
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS) {
      lastReconnectAttempt = now;
      maintainConnection();
    }
  } else {
    mqttClient.loop(); // Keeps keep-alive ping/pong active
  }

  // 3. Periodic Adaptive Telemetry Broadcast
  float spd = gps.speed.isValid() ? gps.speed.kmph() : 0.0;
  unsigned long activeInterval = (spd >= 3.0) ? MOVING_INTERVAL_MS : STATIONARY_INTERVAL_MS;

  unsigned long now = millis();
  if (now - lastSendTime >= activeInterval) {
    lastSendTime = now;

    if (mqttClient.connected()) {
      publishTelemetry(spd);
    }
  }
}

void maintainConnection() {
  // Verify GPRS link at modem layer first
  if (!modem.isGprsConnected()) {
    Serial.println(F("GPRS link dropped. Re-attaching..."));
    if (!modem.isNetworkConnected()) {
      modem.waitForNetwork(3000L);
    }
    modem.gprsConnect(APN, GPRS_USER, GPRS_PASS);
    return;
  }

  if (!mqttClient.connected()) {
    char clientId[32];
    snprintf(clientId, sizeof(clientId), "BusFleet-%s-%04d", BUS_PLATE, random(1000, 9999));
    
    if (mqttClient.connect(clientId)) {
      Serial.println(F("MQTT RECONNECTED STABLE!"));
    }
  }
}

void publishTelemetry(float spd) {
  // Discard until 3D satellite lock is secure (4+ satellites)
  if (!gps.location.isValid() || gps.location.lat() == 0.0 || gps.satellites.value() < 4) {
    return;
  }

  double lat = gps.location.lat();
  double lng = gps.location.lng();
  double alt = gps.altitude.isValid() ? gps.altitude.meters() : 0.0;
  int sats   = gps.satellites.value();
  double hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 1.5;

  // Latch heading when stopped to prevent map marker rotation jitter
  if (spd >= 3.0 && gps.course.isValid()) {
    lastKnownHeading = gps.course.deg();
  }

  char payload[220];
  if (strlen(TRIP_DIRECTION) > 0) {
    snprintf(payload, sizeof(payload),
      "{\"route\":\"%s\",\"bus_no\":\"%s\",\"lat\":%.6f,\"lng\":%.6f,\"spd\":%.1f,\"heading\":%.1f,\"alt\":%.1f,\"sats\":%d,\"hdop\":%.2f,\"dir\":\"%s\"}",
      ROUTE_ID, BUS_PLATE, lat, lng, spd, lastKnownHeading, alt, sats, hdop, TRIP_DIRECTION
    );
  } else {
    snprintf(payload, sizeof(payload),
      "{\"route\":\"%s\",\"bus_no\":\"%s\",\"lat\":%.6f,\"lng\":%.6f,\"spd\":%.1f,\"heading\":%.1f,\"alt\":%.1f,\"sats\":%d,\"hdop\":%.2f}",
      ROUTE_ID, BUS_PLATE, lat, lng, spd, lastKnownHeading, alt, sats, hdop
    );
  }

  boolean success = mqttClient.publish(MQTT_TOPIC, payload);

  if (success) {
    Serial.print(F("Published -> "));
    Serial.println(payload);
  } else {
    Serial.println(F("Publish FAILED (TCP Buffer Busy)"));
  }
}