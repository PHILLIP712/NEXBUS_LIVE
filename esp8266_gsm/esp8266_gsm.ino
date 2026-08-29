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

// 2-Second Telemetry Broadcast Interval
const unsigned long SEND_INTERVAL = 2000;
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

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(GSM_RESET_PIN, OUTPUT);
  digitalWrite(GSM_RESET_PIN, HIGH);

  gsmSerial.begin(9600);
  gpsSerial.begin(9600);
  delay(1000);

  Serial.println("\n--- Starting Scalable Fleet Tracker (2s Glitch-Free) ---");

  // Hardware Reset SIM800L on startup
  digitalWrite(GSM_RESET_PIN, LOW);
  delay(1000);
  digitalWrite(GSM_RESET_PIN, HIGH);
  delay(3000);

  modem.init();

  // Expand buffer to 512 bytes to prevent dropping packets
  mqttClient.setBufferSize(512);
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setSocketTimeout(15);
}

void loop() {
  // 1. Continuous GPS sentence decoding
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

  // 2. Network & MQTT session management
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > 5000) {
      lastReconnectAttempt = now;
      maintainConnection();
    }
  } else {
    mqttClient.loop();
  }

  // 3. Periodic Broadcast
  unsigned long now = millis();
  if (now - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = now;

    if (mqttClient.connected()) {
      publishTelemetry();
    }
  }
}

void maintainConnection() {
  if (!modem.isNetworkConnected()) {
    Serial.print("Searching Cellular Network...");
    if (!modem.waitForNetwork(10000)) {
      Serial.println(" FAIL");
      return;
    }
    Serial.println(" REGISTERED");
  }

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
  // Discard broadcast until GPS acquires real satellite lock (eliminates initial jump line)
  if (!gps.location.isValid() || gps.location.lat() == 0.0 || gps.satellites.value() < 3) {
    Serial.println("Waiting for 3D GPS satellite lock (skipping transmission)...");
    return;
  }

  double lat = gps.location.lat();
  double lng = gps.location.lng();
  double spd = gps.speed.isValid() ? gps.speed.kmph() : 0.0;
  double heading = gps.course.isValid() ? gps.course.deg() : 0.0;
  double alt = gps.altitude.isValid() ? gps.altitude.meters() : 0.0;
  int sats = gps.satellites.value();
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