#define TINY_GSM_MODEM_SIM800
#include <SoftwareSerial.h>
#include <TinyGsmClient.h>
#include <PubSubClient.h>
#include <TinyGPSPlus.h>

// ============================================================
// HARDWARE & VEHICLE CONFIGURATION (EDIT FOR EACH VEHICLE)
// ============================================================
const char* ROUTE_ID          = "77A_NOBATA";   // Route matching routes.js
const char* BUS_PLATE         = "WB42U2676";    // Bus Number Plate
const char* APN               = "bsnlnet";      // Cellular APN
const char* GPRS_USER         = "";
const char* GPRS_PASS         = "";

const char* MQTT_BROKER       = "broker.hivemq.com";
const int   MQTT_PORT         = 1883;
const unsigned long SEND_INTERVAL = 3000;       // Broadcast every 3 seconds
// ============================================================

// SoftwareSerial for SIM800L (RX=D2/GPIO4, TX=D1/GPIO5)
SoftwareSerial gsmSerial(4, 5);
TinyGsm modem(gsmSerial);
TinyGsmClient gsmClient(modem);
PubSubClient mqttClient(gsmClient);

// SoftwareSerial for GPS (RX=D5/GPIO14, TX=D6/GPIO12)
SoftwareSerial gpsSerial(14, 12);
TinyGPSPlus gps;

const int GSM_RESET_PIN = 13; // D7
unsigned long lastSendTime = 0;

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(GSM_RESET_PIN, OUTPUT);
  digitalWrite(GSM_RESET_PIN, HIGH);

  gsmSerial.begin(9600);
  gpsSerial.begin(9600);
  delay(1000);

  Serial.println("\n--- Starting Scalable Fleet Tracker ---");

  // Hardware reboot SIM800L
  digitalWrite(GSM_RESET_PIN, LOW);
  delay(1000);
  digitalWrite(GSM_RESET_PIN, HIGH);
  delay(5000);

  modem.restart();
  connectCellularAndMQTT();
}

void loop() {
  // Feed GPS parser
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

  // Maintain MQTT session
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  // Periodic Telemetry Broadcast
  unsigned long now = millis();
  if (now - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = now;

    if (gps.location.isValid() && gps.location.lat() != 0.0) {
      publishTelemetry();
    } else {
      Serial.println("Acquiring GPS fix...");
    }
  }
}

void connectCellularAndMQTT() {
  Serial.print("Connecting to cellular network...");
  if (!modem.waitForNetwork(30000)) {
    Serial.println(" FAIL");
    return;
  }
  Serial.println(" OK");

  Serial.print("Connecting to GPRS (");
  Serial.print(APN);
  Serial.print(")...");
  if (!modem.gprsConnect(APN, GPRS_USER, GPRS_PASS)) {
    Serial.println(" FAIL");
    return;
  }
  Serial.println(" OK");

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  reconnectMQTT();
}

void reconnectMQTT() {
  while (!mqttClient.connected()) {
    String clientId = "BusFleet-" + String(BUS_PLATE) + "-" + String(random(1000, 9999));
    Serial.print("Connecting to MQTT Broker as ");
    Serial.print(clientId);
    Serial.print("...");

    if (mqttClient.connect(clientId.c_str())) {
      Serial.println(" Connected!");
    } else {
      Serial.print(" Failed (rc=");
      Serial.print(mqttClient.state());
      Serial.println("). Retrying in 3s...");
      delay(3000);
    }
  }
}

void publishTelemetry() {
  String payload = "{";
  payload += "\"route\":\"" + String(ROUTE_ID) + "\",";
  payload += "\"bus_no\":\"" + String(BUS_PLATE) + "\",";
  payload += "\"lat\":" + String(gps.location.lat(), 6) + ",";
  payload += "\"lng\":" + String(gps.location.lng(), 6) + ",";
  payload += "\"spd\":" + String(gps.speed.kmph(), 1) + ",";
  payload += "\"heading\":" + String(gps.course.deg(), 1) + ",";
  payload += "\"alt\":" + String(gps.altitude.meters(), 1) + ",";
  payload += "\"sats\":" + String(gps.satellites.value()) + ",";
  payload += "\"hdop\":" + String(gps.hdop.hdop(), 2);
  payload += "}";

  String topic = "citytransit/fleet/" + String(ROUTE_ID) + "/" + String(BUS_PLATE) + "/data";
  topic.toLowerCase();

  Serial.print("Publishing to ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(payload);

  mqttClient.publish(topic.c_str(), payload.c_str());
}