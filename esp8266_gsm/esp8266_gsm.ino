#define TINY_GSM_MODEM_SIM800
#include <SoftwareSerial.h>
#include <TinyGsmClient.h>
#include <PubSubClient.h>
#include <TinyGPSPlus.h>

// ============================================================
// HARDWARE & VEHICLE CONFIGURATION
// ============================================================
const char* ROUTE_ID          = "77A_NOBATA";   // Route matching routes.js
const char* BUS_PLATE         = "WB42U2676";    // Bus Number Plate
const char* APN               = "bsnlnet";      // Cellular APN
const char* GPRS_USER         = "";
const char* GPRS_PASS         = "";

const char* MQTT_BROKER       = "broker.hivemq.com";
const int   MQTT_PORT         = 1883;
const unsigned long SEND_INTERVAL = 3000;       // Broadcast every 3.0 seconds
// ============================================================

// SIM800L SoftwareSerial (RX=D2/GPIO4, TX=D1/GPIO5)
SoftwareSerial gsmSerial(4, 5);
TinyGsm modem(gsmSerial);
TinyGsmClient gsmClient(modem);
PubSubClient mqttClient(gsmClient);

// NEO-6M GPS SoftwareSerial (RX=D5/GPIO14 -> GPS TX, TX=D6/GPIO12 -> GPS RX)
SoftwareSerial gpsSerial(14, 12);
TinyGPSPlus gps;

const int GSM_RESET_PIN = 13; // D7 / GPIO13
unsigned long lastSendTime = 0;
unsigned long lastReconnectAttempt = 0;

void setup() {
  Serial.begin(115200);
  delay(500);

  // Hardware Reset SIM800L on startup
  pinMode(GSM_RESET_PIN, OUTPUT);
  digitalWrite(GSM_RESET_PIN, HIGH);

  gsmSerial.begin(9600);
  gpsSerial.begin(9600);
  delay(1000);

  Serial.println("\n--- Starting Scalable Fleet Tracker ---");

  digitalWrite(GSM_RESET_PIN, LOW);
  delay(1000);
  digitalWrite(GSM_RESET_PIN, HIGH);
  delay(3000);

  modem.init();

  // Expand MQTT buffer to prevent dropping 180+ byte JSON packets
  mqttClient.setBufferSize(512);
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setSocketTimeout(15);
}

void loop() {
  // 1. Continuously feed GPS parser
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

  // 2. Multi-stage Cellular & MQTT session watchdog
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > 5000) {
      lastReconnectAttempt = now;
      maintainConnection();
    }
  } else {
    mqttClient.loop();
  }

  // 3. Periodic Telemetry Broadcast
  unsigned long now = millis();
  if (now - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = now;

    if (mqttClient.connected()) {
      publishTelemetry();
    }
  }
}

void maintainConnection() {
  // Step A: Ensure Cellular Network is Registered
  if (!modem.isNetworkConnected()) {
    Serial.print("Searching Cellular Network...");
    if (!modem.waitForNetwork(10000)) {
      Serial.println(" FAIL");
      return;
    }
    Serial.println(" REGISTERED");
  }

  // Step B: Ensure GPRS Data Context is Attached
  if (!modem.isGprsConnected()) {
    Serial.print("Attaching GPRS (");
    Serial.print(APN);
    Serial.print(")...");
    if (!modem.gprsConnect(APN, GPRS_USER, GPRS_PASS)) {
      Serial.println(" FAIL");
      return;
    }
    Serial.println(" ATTACHED");
  }

  // Step C: Connect to HiveMQ MQTT Broker
  if (!mqttClient.connected()) {
    String clientId = "BusFleet-" + String(BUS_PLATE) + "-" + String(random(1000, 9999));
    Serial.print("Connecting to HiveMQ (" + clientId + ")...");

    if (mqttClient.connect(clientId.c_str())) {
      Serial.println(" CONNECTED!");
    } else {
      Serial.print(" FAIL (rc=");
      Serial.print(mqttClient.state());
      Serial.println(")");
    }
  }
}

void publishTelemetry() {
  // Use live GPS coordinates when locked; fallback to route starting coordinates
  double lat = (gps.location.isValid() && gps.location.lat() != 0.0) ? gps.location.lat() : 22.487139;
  double lng = (gps.location.isValid() && gps.location.lng() != 0.0) ? gps.location.lng() : 88.189639;
  double spd = gps.speed.isValid() ? gps.speed.kmph() : 0.0;
  double heading = gps.course.isValid() ? gps.course.deg() : 90.0;
  double alt = gps.altitude.isValid() ? gps.altitude.meters() : 0.0;
  int sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
  double hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 1.0;

  String payload = "{";
  payload += "\"route\":\"" + String(ROUTE_ID) + "\",";
  payload += "\"bus_no\":\"" + String(BUS_PLATE) + "\",";
  payload += "\"lat\":" + String(lat, 6) + ",";
  payload += "\"lng\":" + String(lng, 6) + ",";
  payload += "\"spd\":" + String(spd, 1) + ",";
  payload += "\"heading\":" + String(heading, 1) + ",";
  payload += "\"alt\":" + String(alt, 1) + ",";
  payload += "\"sats\":" + String(sats) + ",";
  payload += "\"hdop\":" + String(hdop, 2);
  payload += "}";

  String topic = "citytransit/fleet/" + String(ROUTE_ID) + "/" + String(BUS_PLATE) + "/data";
  topic.toLowerCase();

  Serial.print("Publishing to " + topic + " -> ");
  boolean success = mqttClient.publish(topic.c_str(), payload.c_str());

  if (success) {
    Serial.println("SUCCESS: " + payload);
  } else {
    Serial.println("FAILED (Packet dropped)");
  }
}