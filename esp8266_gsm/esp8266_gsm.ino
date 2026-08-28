#include <SoftwareSerial.h>
#include <TinyGPSPlus.h>

// ============================================================
// HARDWARE CONFIGURATION
// ============================================================
const char* ROUTE_ID          = "77A_NOBATA";
const char* BUS_PLATE     = "WB42U2676";
const char* THINGSPEAK_KEY    = "TSJ4BD1P0IT27XJG";
// ============================================================

// SoftwareSerial for SIM800L (RX, TX) -> NodeMCU D2, D1
SoftwareSerial gsmSerial(4, 5); 

// GPS Serial Pins (NodeMCU D5=RX, D6=TX)
static const int RXPin = 14; 
static const int TXPin = 12; 
static const uint32_t GPSBaud = 9600;
SoftwareSerial gpsSerial(RXPin, TXPin);

TinyGPSPlus gps;

const int GSM_RESET_PIN = 13; // D7
const unsigned long POST_INTERVAL = 10000; // Send telemetry every 10 seconds
unsigned long lastPostTime = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(GSM_RESET_PIN, OUTPUT);
  digitalWrite(GSM_RESET_PIN, HIGH);

  gsmSerial.begin(9600);
  gpsSerial.begin(GPSBaud);
  delay(1000);

  Serial.println("\n--- Initializing ThingSpeak Cellular Bus Tracker ---");
  
  // Hardware reset SIM800L module
  digitalWrite(GSM_RESET_PIN, LOW);
  delay(1000);
  digitalWrite(GSM_RESET_PIN, HIGH);
  delay(6000); // Wait for module boot

  // Initialize BSNL GPRS connection
  setupGPRS();
}

void loop() {
  // Continuously ingest GPS data packets
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield();
  }

  // Periodically send telemetry via GPRS HTTP GET
  unsigned long now = millis();
  if (now - lastPostTime >= POST_INTERVAL) {
    lastPostTime = now;

    if (gps.location.isValid() && gps.location.lat() != 0.0) {
      sendTelemetryData();
    } else {
      Serial.println("Waiting for valid GPS fix...");
    }
  }
}

void sendATCommand(String cmd, int timeout) {
  gsmSerial.println(cmd);
  long int time = millis();
  while ((millis() - time) < timeout) {
    while (gsmSerial.available()) {
      Serial.write(gsmSerial.read());
    }
  }
}

void setupGPRS() {
  Serial.println("Setting up GPRS Bearer...");
  sendATCommand("AT+SAPBR=3,1,\"Contype\",\"GPRS\"", 2000);
  sendATCommand("AT+SAPBR=3,1,\"APN\",\"bsnlnet\"", 2000);
  sendATCommand("AT+SAPBR=1,1", 5000);
  sendATCommand("AT+SAPBR=2,1", 3000);
}

void sendTelemetryData() {
  Serial.println("\nSending telemetry to ThingSpeak...");

  String url = "http://api.thingspeak.com/update?api_key=" + String(THINGSPEAK_KEY);
  url += "&field1=" + String(gps.location.lat(), 6);
  url += "&field2=" + String(gps.location.lng(), 6);
  url += "&field3=" + String(gps.speed.kmph(), 1);
  url += "&field4=" + String(gps.course.deg(), 1);
  url += "&field5=" + String(ROUTE_ID);
  url += "&field6=" + String(BUS_PLATE);

  sendATCommand("AT+HTTPINIT", 2000);
  sendATCommand("AT+HTTPPARA=\"CID\",1", 2000);
  
  gsmSerial.print("AT+HTTPPARA=\"URL\",\"");
  gsmSerial.print(url);
  gsmSerial.println("\"");
  delay(1000);

  sendATCommand("AT+HTTPACTION=0", 5000); // GET request
  sendATCommand("AT+HTTPREAD", 3000);
  sendATCommand("AT+HTTPTERM", 2000);
  
  Serial.println("Telemetry cycle complete.");
}