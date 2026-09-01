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

// Adaptive Transmission Intervals
const unsigned long MOVING_INTERVAL_MS     = 3000;  // 3s while moving
const unsigned long STATIONARY_INTERVAL_MS = 8000;  // 8s when stopped (prevents 2G packet drop)
const unsigned long RECONNECT_INTERVAL_MS  = 5000;  // 5s between broker retries
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

  // Initialize both UART ports
  gsmSerial.begin(9600);
  gpsSerial.begin(9600);
  gpsSerial.listen(); // Ensure GPS is actively listening

  Serial.println(F("\n--- Starting Scalable Fleet Tracker (Optimized) ---"));

  // Hardware Reset SIM800L on startup
  digitalWrite(GSM_RESET_PIN, LOW);
  delay(1000);
  digitalWrite(GSM_RESET_PIN, HIGH);
  delay(3000);

  gsmSerial.listen();
  modem.init();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setBufferSize(256);   // Compact fixed buffer
  mqttClient.setKeepAlive(60);     // 60-second window to prevent disconnects on slow 2G
  mqttClient.setSocketTimeout(6);  // Non-blocking 6s timeout
}

void loop() {
  // 1. Continuous GPS sentence decoding (listen to GPS port)
  gpsSerial.listen();
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

  // 2. Network & MQTT session management (listen to GSM port)
  gsmSerial.listen();
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS) {
      lastReconnectAttempt = now;
      maintainConnection();
    }
  } else {
    mqttClient.loop();
  }

  // 3. Periodic Adaptive Broadcast
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
  if (!modem.isNetworkConnected()) {
    Serial.print(F("Searching Cellular Network..."));
    if (!modem.waitForNetwork(3000L)) { // Short 3-second non-blocking check
      Serial.println(F(" FAIL"));
      return;
    }
    Serial.println(F(" REGISTERED"));
  }

  if (!modem.isGprsConnected()) {
    Serial.print(F("Attaching GPRS ("));
    Serial.print(APN);
    Serial.print(F(")..."));
    if (!modem.gprsConnect(APN, GPRS_USER, GPRS_PASS)) {
      Serial.println(F(" FAIL"));
      return;
    }
    Serial.println(F(" ATTACHED"));
  }

  if (!mqttClient.connected()) {
    char clientId[32];
    snprintf(clientId, sizeof(clientId), "BusFleet-%s-%04d", BUS_PLATE, random(1000, 9999));
    Serial.print(F("Connecting to HiveMQ ("));
    Serial.print(clientId);
    Serial.print(F(")..."));

    if (mqttClient.connect(clientId)) {
      Serial.println(F(" CONNECTED!"));
    } else {
      Serial.print(F(" FAIL (rc="));
      Serial.print(mqttClient.state());
      Serial.println(F(")"));
    }
  }
}

void publishTelemetry(float spd) {
  // Discard broadcast until GPS acquires a minimum 3D lock (4+ satellites)
  if (!gps.location.isValid() || gps.location.lat() == 0.0 || gps.satellites.value() < 4) {
    Serial.println(F("Waiting for 3D GPS satellite lock (skipping transmission)..."));
    return;
  }

  double lat = gps.location.lat();
  double lng = gps.location.lng();
  double alt = gps.altitude.isValid() ? gps.altitude.meters() : 0.0;
  int sats   = gps.satellites.value();
  double hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 1.5;

  // Latch heading when stationary to prevent marker spinning on the map
  if (spd >= 3.0 && gps.course.isValid()) {
    lastKnownHeading = gps.course.deg();
  }

  // Pre-allocated char buffer prevents heap fragmentation on ESP8266
  char payload[200];
  snprintf(payload, sizeof(payload),
    "{\"route\":\"%s\",\"bus_no\":\"%s\",\"lat\":%.6f,\"lng\":%.6f,\"spd\":%.1f,\"heading\":%.1f,\"alt\":%.1f,\"sats\":%d,\"hdop\":%.2f}",
    ROUTE_ID,
    BUS_PLATE,
    lat,
    lng,
    spd,
    lastKnownHeading,
    alt,
    sats,
    hdop
  );

  Serial.print(F("Publishing to "));
  Serial.print(MQTT_TOPIC);
  Serial.print(F(" -> "));

  boolean success = mqttClient.publish(MQTT_TOPIC, payload);

  if (success) {
    Serial.print(F("SUCCESS: "));
    Serial.println(payload);
  } else {
    Serial.println(F("FAILED (Packet dropped)"));
  }
}