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

// Switched to EMQX Public Broker (Faster & Higher Rate Limits)
const char* MQTT_BROKER       = "broker.emqx.io";
const int   MQTT_PORT         = 1883;
const char* MQTT_TOPIC        = "citytransit/fleet/77a_nobata/wb42u2676/data";

// Leave blank ("") so the web app's 4-tier engine handles direction automatically
const char* TRIP_DIRECTION    = ""; 

// Option 1: Pushing 2G limits safely
const unsigned long MOVING_INTERVAL_MS     = 3000;   // 3s while moving
const unsigned long STATIONARY_INTERVAL_MS = 10000;  // 10s when stationary to clear TCP buffer
const unsigned long RECONNECT_INTERVAL_MS  = 5000;   // 5s between broker retry attempts
// ============================================================

SoftwareSerial gsmSerial(4, 5);
TinyGsm modem(gsmSerial);
TinyGsmClient gsmClient(modem);
PubSubClient mqttClient(gsmClient);

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

  Serial.println(F("\n--- Starting Scalable Fleet Tracker (Optimized for 2G Edge Limits) ---"));

  digitalWrite(GSM_RESET_PIN, LOW);
  delay(1000);
  digitalWrite(GSM_RESET_PIN, HIGH);
  delay(3000);

  gsmSerial.listen();
  modem.init();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setBufferSize(256);
  mqttClient.setKeepAlive(60);     // Increased keepalive to prevent timeout drops
  mqttClient.setSocketTimeout(15); // Increased socket allowance for slow carrier handoffs
}

void loop() {
  gpsSerial.listen();
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

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
  // Relaxed from 4 to 3 satellites to prevent map freezing under trees
  if (!gps.location.isValid() || gps.location.lat() == 0.0 || gps.satellites.value() < 3) {
    Serial.println(F("Skipping publish: Waiting for better GPS lock..."));
    return;
  }

  double lat = gps.location.lat();
  double lng = gps.location.lng();
  double alt = gps.altitude.isValid() ? gps.altitude.meters() : 0.0;
  int sats   = gps.satellites.value();
  double hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 1.5;

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