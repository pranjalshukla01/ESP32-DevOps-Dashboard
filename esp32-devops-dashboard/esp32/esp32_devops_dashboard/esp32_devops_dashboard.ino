

#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <esp_timer.h>  

const char* WIFI_SSID     = "Bing";      
const char* WIFI_PASSWORD = "vkashbhg";  
const char* API_KEY       = "esp32-secret";        

const uint16_t HTTP_PORT = 80;
const uint16_t WS_PORT   = 81;


WebServer server(HTTP_PORT);
WebSocketsServer webSocket(WS_PORT);


const char* HEADER_KEYS[] = {"X-Api-Key"};


uint32_t totalRequests    = 0;   
uint32_t successRequests  = 0;   
uint32_t errorRequests    = 0;   
uint32_t notFoundRequests = 0;   

const int RPS_WINDOW = 5;
uint32_t rpsBuckets[RPS_WINDOW] = {0};
int      rpsIndex = 0;
uint32_t requestsThisSecond = 0;
float    requestsPerSecond  = 0.0;
unsigned long lastSecondTick = 0;


const int LOG_CAPACITY = 50;
struct LogEntry {
  uint32_t id;          
  uint32_t uptimeSec;   
  char     message[56];
};
LogEntry logBuffer[LOG_CAPACITY];
int      logHead  = 0;   
int      logCount = 0;   
uint32_t nextLogId = 1;


bool          restartPending     = false;
unsigned long restartRequestedAt = 0;


unsigned long lastWsMetricsAt = 0;
bool wasWifiConnected = false;


uint32_t uptimeSeconds() {
 
  return (uint32_t)(esp_timer_get_time() / 1000000ULL);
}


void formatClock(uint32_t totalSec, char* out, size_t outSize) {
  snprintf(out, outSize, "%02lu:%02lu:%02lu",
           (unsigned long)(totalSec / 3600),
           (unsigned long)((totalSec / 60) % 60),
           (unsigned long)(totalSec % 60));
}


void jsonEscape(const char* in, String& out) {
  for (; *in; in++) {
    char c = *in;
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if ((uint8_t)c < 0x20 || (uint8_t)c > 0x7E) { out += '?'; }  
    else { out += c; }
  }
}

const char* methodName(HTTPMethod m) {
  switch (m) {
    case HTTP_GET:     return "GET";
    case HTTP_POST:    return "POST";
    case HTTP_PUT:     return "PUT";
    case HTTP_DELETE:  return "DELETE";
    case HTTP_OPTIONS: return "OPTIONS";
    default:           return "OTHER";
  }
}


void broadcastLog(const LogEntry& e) {
  if (webSocket.connectedClients() == 0) return;   
  char clock[16];
  formatClock(e.uptimeSec, clock, sizeof(clock));
  String esc;
  jsonEscape(e.message, esc);
  String msg = "{\"type\":\"log\",\"data\":{\"id\":" + String(e.id) +
               ",\"time\":\"" + clock + "\",\"message\":\"" + esc + "\"}}";
  webSocket.broadcastTXT(msg);
}

void addLog(const char* message) {
  LogEntry& e = logBuffer[logHead];
  e.id = nextLogId++;
  e.uptimeSec = uptimeSeconds();
  strncpy(e.message, message, sizeof(e.message) - 1);
  e.message[sizeof(e.message) - 1] = '\0';

  logHead = (logHead + 1) % LOG_CAPACITY;
  if (logCount < LOG_CAPACITY) logCount++;

  Serial.printf("[LOG] %s\n", e.message);
  broadcastLog(e);
}


void addCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.sendHeader("Access-Control-Max-Age", "600");
  server.sendHeader("Cache-Control", "no-store");
}


void recordRequest(int code) {
  totalRequests++;
  requestsThisSecond++;
  if (code >= 200 && code < 400) {
    successRequests++;
  } else {
    errorRequests++;
    if (code == 404) notFoundRequests++;
  }
  String msg = String(methodName(server.method())) + " " + server.uri();
  if (code >= 400) msg += " -> " + String(code);
  addLog(msg.c_str());
}

void sendJson(int code, const String& body) {
  addCorsHeaders();
  server.send(code, "application/json", body);
  recordRequest(code);
}

void sendError(int code, const char* message) {
  String esc;
  jsonEscape(message, esc);
  sendJson(code, "{\"error\":\"" + esc + "\"}");
}


void handleRoot() {
  String ip = WiFi.localIP().toString();
  String html =
    "<!doctype html><html><head><meta charset='utf-8'><title>ESP32 DevOps</title>"
    "<style>body{font-family:sans-serif;background:#0b0f17;color:#e6edf7;padding:2rem}"
    "a{color:#38bdf8}</style></head><body>"
    "<h1>ESP32 DevOps API is running</h1><p>IP: " + ip + "</p><ul>"
    "<li><a href='/health'>/health</a></li>"
    "<li><a href='/api/status'>/api/status</a></li>"
    "<li><a href='/api/metrics'>/api/metrics</a></li>"
    "<li><a href='/api/logs'>/api/logs</a></li>"
    "<li>POST /api/restart (needs X-Api-Key header)</li></ul>"
    "<p>Open the React dashboard on your laptop to see the full UI.</p></body></html>";
  addCorsHeaders();
  server.send(200, "text/html", html);
  recordRequest(200);
}


void handleHealth() {
  sendJson(200, "{\"status\":\"ok\"}");
}


void handleStatus() {
  String ip = WiFi.localIP().toString();
  char buf[320];
  int n = snprintf(buf, sizeof(buf),
    "{\"online\":true,\"uptime\":%lu,\"freeHeap\":%lu,\"cpuFrequency\":%lu,"
    "\"wifiRSSI\":%d,\"ip\":\"%s\",\"requests\":%lu,\"requestsPerSecond\":%.2f}",
    (unsigned long)uptimeSeconds(),
    (unsigned long)ESP.getFreeHeap(),
    (unsigned long)ESP.getCpuFreqMHz(),
    WiFi.RSSI(),
    ip.c_str(),
    (unsigned long)totalRequests,
    requestsPerSecond);
  if (n < 0 || n >= (int)sizeof(buf)) { sendError(500, "Status JSON buffer too small"); return; }
  sendJson(200, String(buf));
}


void handleMetrics() {
  String ip   = WiFi.localIP().toString();
  String mac  = WiFi.macAddress();
  String ssid, sdk, chip;
  jsonEscape(WiFi.SSID().c_str(), ssid);
  jsonEscape(ESP.getSdkVersion(), sdk);
  jsonEscape(ESP.getChipModel(), chip);

  char buf[1100];
  int n = snprintf(buf, sizeof(buf),
    "{\"uptime\":%lu,"
    "\"freeHeap\":%lu,\"totalHeap\":%lu,\"minFreeHeap\":%lu,\"maxAllocHeap\":%lu,"
    "\"cpuFrequency\":%lu,\"cpuUtilization\":null,"
    "\"chipModel\":\"%s\",\"chipRevision\":%lu,\"chipCores\":%lu,"
    "\"sdkVersion\":\"%s\",\"flashSize\":%lu,\"sketchSize\":%lu,"
    "\"wifiSSID\":\"%s\",\"wifiRSSI\":%d,\"ip\":\"%s\",\"mac\":\"%s\","
    "\"requests\":{\"total\":%lu,\"success\":%lu,\"errors\":%lu,\"notFound\":%lu,\"perSecond\":%.2f}}",
    (unsigned long)uptimeSeconds(),
    (unsigned long)ESP.getFreeHeap(),
    (unsigned long)ESP.getHeapSize(),
    (unsigned long)ESP.getMinFreeHeap(),
    (unsigned long)ESP.getMaxAllocHeap(),
    (unsigned long)ESP.getCpuFreqMHz(),
    chip.c_str(),
    (unsigned long)ESP.getChipRevision(),
    (unsigned long)ESP.getChipCores(),
    sdk.c_str(),
    (unsigned long)ESP.getFlashChipSize(),
    (unsigned long)ESP.getSketchSize(),
    ssid.c_str(),
    WiFi.RSSI(),
    ip.c_str(),
    mac.c_str(),
    (unsigned long)totalRequests,
    (unsigned long)successRequests,
    (unsigned long)errorRequests,
    (unsigned long)notFoundRequests,
    requestsPerSecond);
  
  if (n < 0 || n >= (int)sizeof(buf)) { sendError(500, "Metrics JSON buffer too small"); return; }
  sendJson(200, String(buf));
}


void handleLogs() {
  if (ESP.getMaxAllocHeap() < 12000) {            
    sendError(500, "Not enough free memory to build logs");
    return;
  }
  String body;
  body.reserve(LOG_CAPACITY * 120 + 64);
  body = "{\"count\":" + String(logCount) + ",\"logs\":[";

  int start = (logHead - logCount + LOG_CAPACITY) % LOG_CAPACITY;  
  for (int i = 0; i < logCount; i++) {
    const LogEntry& e = logBuffer[(start + i) % LOG_CAPACITY];
    char clock[16];
    formatClock(e.uptimeSec, clock, sizeof(clock));
    String esc;
    jsonEscape(e.message, esc);
    if (i > 0) body += ",";
    body += "{\"id\":" + String(e.id) + ",\"time\":\"" + clock + "\",\"message\":\"" + esc + "\"}";
  }
  body += "]}";
  sendJson(200, body);
}


void handleRestart() {
  String key = server.header("X-Api-Key");
  if (key.length() == 0) { sendError(400, "Missing X-Api-Key header"); return; }
  if (key != API_KEY)    { sendError(401, "Invalid API key");          return; }

  addLog("Restart requested via API");
  sendJson(200, "{\"restarting\":true}");   
  restartPending = true;                    
  restartRequestedAt = millis();
  


void handleNotFound() {
  
  if (server.method() == HTTP_OPTIONS) {
    addCorsHeaders();
    server.send(204, "text/plain", "");
    return;
  }
  
  if (server.uri() == "/api/restart") {
    sendError(405, "Use POST for /api/restart");
    return;
  }
  sendError(404, "Route not found");
}


void broadcastMetrics() {
  if (webSocket.connectedClients() == 0) return;
  char buf[200];
  snprintf(buf, sizeof(buf),
    "{\"type\":\"metrics\",\"data\":{\"uptime\":%lu,\"freeHeap\":%lu,\"wifiRSSI\":%d,"
    "\"requests\":%lu,\"requestsPerSecond\":%.2f}}",
    (unsigned long)uptimeSeconds(),
    (unsigned long)ESP.getFreeHeap(),
    WiFi.RSSI(),
    (unsigned long)totalRequests,
    requestsPerSecond);
  webSocket.broadcastTXT(buf);
}

void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  char msg[48];
  switch (type) {
    case WStype_CONNECTED:
      snprintf(msg, sizeof(msg), "WebSocket client #%u connected", num);
      addLog(msg);
      break;
    case WStype_DISCONNECTED:
      snprintf(msg, sizeof(msg), "WebSocket client #%u disconnected", num);
      addLog(msg);
      break;
    default:
      break; 
  }
}


void printWifiInfo() {
  Serial.println();
  Serial.println("Wi-Fi connected!");
  Serial.print("  SSID: ");  Serial.println(WiFi.SSID());
  Serial.print("  IP:   ");  Serial.println(WiFi.localIP());
  Serial.print("  RSSI: ");  Serial.print(WiFi.RSSI()); Serial.println(" dBm");
  Serial.println(">>> Put this IP in frontend/src/api.js (ESP32_IP) <<<");
}


void maintainWifi() {
  static unsigned long lastCheck = 0;
  if (millis() - lastCheck < 5000) return;
  lastCheck = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasWifiConnected) {
      wasWifiConnected = true;
      addLog("Wi-Fi connected");
      printWifiInfo();
    }
    return;
  }
  if (wasWifiConnected) {
    wasWifiConnected = false;
    addLog("Wi-Fi connection lost");
  }
  Serial.println("Wi-Fi down, trying to reconnect...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}


void tickRequestRate() {
  if (millis() - lastSecondTick < 1000) return;
  lastSecondTick = millis();
  rpsBuckets[rpsIndex] = requestsThisSecond;
  requestsThisSecond = 0;
  rpsIndex = (rpsIndex + 1) % RPS_WINDOW;
  uint32_t sum = 0;
  for (int i = 0; i < RPS_WINDOW; i++) sum += rpsBuckets[i];
  requestsPerSecond = (float)sum / RPS_WINDOW;
}


void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== ESP32 Mini DevOps Dashboard ===");
  addLog("Booting");

  if (String(WIFI_SSID) == "YOUR_WIFI_NAME") {
    Serial.println("WARNING: edit WIFI_SSID / WIFI_PASSWORD at the top of the sketch!");
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 20000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    wasWifiConnected = true;
    addLog("Wi-Fi connected");
    printWifiInfo();
  } else {
    Serial.println("\nCould not connect yet. Will keep retrying in the background.");
  }

  
  server.on("/",            HTTP_GET,  handleRoot);
  server.on("/health",      HTTP_GET,  handleHealth);
  server.on("/api/status",  HTTP_GET,  handleStatus);
  server.on("/api/metrics", HTTP_GET,  handleMetrics);
  server.on("/api/logs",    HTTP_GET,  handleLogs);
  server.on("/api/restart", HTTP_POST, handleRestart);
  server.onNotFound(handleNotFound);
  server.collectHeaders(HEADER_KEYS, 1);
  server.begin();
  Serial.println("HTTP server started on port 80");

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  Serial.println("WebSocket server started on port 81");

  addLog("Server ready");
}

void loop() {
  server.handleClient();   
  webSocket.loop();        
  maintainWifi();
  tickRequestRate();

  
  if (millis() - lastWsMetricsAt >= 2000) {
    lastWsMetricsAt = millis();
    broadcastMetrics();
  }

  
  if (restartPending && millis() - restartRequestedAt >= 1500) {
    Serial.println("Restarting now...");
    ESP.restart();
  }

  delay(1);  
}