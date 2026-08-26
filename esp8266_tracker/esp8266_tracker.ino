#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <SoftwareSerial.h>
#include <TinyGPSPlus.h>

// ============================================================
// HARDWARE CONFIGURATION (ONLY CHANGE THIS BLOCK FOR EACH BUS)
// ============================================================
const char* WIFI_SSID     = "Infinix";
const char* WIFI_PASS     = "1234567890";

// Use clean standardized route IDs: "77A_NOBATA", "77A_BATA", or "S126"
const char* ROUTE_ID      = "77A_NOBATA";
const char* BUS_PLATE     = "WB42U2676";
const char* MQTT_TOPIC    = "citytransit/77a_nobata/WB42U2676/data";
// ============================================================

const char* mqtt_server   = "broker.hivemq.com";
const int   mqtt_port     = 1883;

// GPS Serial Pins (NodeMCU D5=RX, D6=TX)
static const int RXPin    = 14; 
static const int TXPin    = 12; 
static const uint32_t GPSBaud = 9600;

TinyGPSPlus gps;
SoftwareSerial gpsSerial(RXPin, TXPin);
WiFiClient espClient;
PubSubClient client(espClient);

unsigned long lastMsg = 0;

void reconnect() {
  while (!client.connected()) {
    String clientId = "ESP8266-" + String(BUS_PLATE) + "-" + String(random(0xffff), HEX);
    if (client.connect(clientId.c_str())) {
      Serial.println("MQTT Broker Connected!");
    } else {
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(GPSBaud);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
  }

  client.setServer(mqtt_server, mqtt_port);
  client.setBufferSize(512);
}

void loop() {
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

  if (!client.connected()) {
    reconnect();
  }
  client.loop();

  unsigned long now = millis();
  if (now - lastMsg > 1000) {
    lastMsg = now;

    if (gps.location.isValid() && gps.location.lat() != 0.0) {
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

      client.publish(MQTT_TOPIC, payload.c_str());
      Serial.println("Published: " + payload);
    }
  }
}