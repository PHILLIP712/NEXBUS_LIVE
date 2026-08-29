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
const unsigned long SEND_INTERVAL = 3000;
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
unsigned long lastReconnectAttempt = 0;

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(GSM_RESET_PIN, OUTPUT);
  digitalWrite(GSM_RESET_PIN, HIGH);

  gsmSerial.begin(9600);
  gpsSerial.begin(9600);
  delay(1000);

  Serial.println("\n--- Starting Scalable Fleet Tracker ---");

  // Hardware Reset SIM800L
  digitalWrite(GSM_RESET_PIN, LOW);
  delay(1000);
  digitalWrite(GSM_RESET_PIN, HIGH);
  delay(3000);

  modem.init();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setSocketTimeout(15); // Increase socket timeout for 2G network latency
}

void loop() {
  // 1. Continuous GPS decoding
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

  // 2. Multi-stage Network & MQTT Maintenance
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
      if (gps.location.isValid() && gps.location.lat() != 0.0) {
        publishTelemetry();
      } else {
        Serial.println("Waiting for outdoor GPS satellite fix...");
      }
    }
  }
}

void maintainConnection() {
  // Step A: Check Cellular Network Registration
  if (!modem.isNetworkConnected()) {
    Serial.print("Searching Cellular Network...");
    if (!modem.waitForNetwork(15000)) {
      Serial.println(" NOT REGISTERED (Check antenna / power)");
      return;
    }
    Serial.println(" REGISTERED");
  }

  // Step B: Attach GPRS Data Context
  if (!modem.isGprsConnected()) {
    Serial.print("Attaching GPRS (");
    Serial.print(APN);
    Serial.print(")...");
    if (!modem.gprsConnect(APN, GPRS_USER, GPRS_PASS)) {
      Serial.println(" GPRS FAIL");
      return;
    }
    Serial.println(" GPRS ATTACHED");
  }

  // Step C: Establish MQTT Socket
  if (!mqttClient.connected()) {
    String clientId = "BusFleet-" + String(BUS_PLATE) + "-" + String(random(1000, 9999));
    Serial.print("Connecting to HiveMQ as ");
    Serial.print(clientId);
    Serial.print("...");

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

  Serial.print("Published: ");
  Serial.println(payload);

  mqttClient.publish(topic.c_str(), payload.c_str());
}