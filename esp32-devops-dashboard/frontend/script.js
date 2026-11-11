
const ESP32_IP = "10.126.83.53";   
const API_KEY  = "esp32-secret";   

const BASE_URL   = "http://" + ESP32_IP;
const WS_URL     = "ws://" + ESP32_IP + ":81";
const POLL_MS    = 3000;   
const TIMEOUT_MS = 4000;    
const MAX_POINTS = 40;     
const MAX_LOGS   = 60;     
const RESTART_WAIT_MS = 60000; 


let connection = "loading";
let status  = null;         
let metrics = null;          
let logs    = [];            
let history = [];           
let wsConnected = false;
let pollInFlight = false;
let restart = { active: false, sawOffline: false, startedAt: 0 };


const $ = (id) => document.getElementById(id);


async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(BASE_URL + path, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw new Error("Cannot reach ESP32 (offline, wrong IP, or blocked)");
  } finally {
    clearTimeout(timer);
  }

 
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    if (response.ok) throw new Error("ESP32 sent invalid JSON");
  }

  if (!response.ok) {
    throw new Error((data && data.error) || "HTTP " + response.status);
  }
  return data;
}

const getHealth  = () => request("/health");
const getStatus  = () => request("/api/status");
const getMetrics = () => request("/api/metrics");
const getLogs    = () => request("/api/logs");
const postRestart = () =>
  request("/api/restart", { method: "POST", headers: { "X-Api-Key": API_KEY } });


function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatUptime(sec) {
  if (typeof sec !== "number") return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return (d > 0 ? d + "d " : "") + pad(h) + ":" + pad(m) + ":" + pad(s);
}

const formatKB = (b) => (typeof b === "number" ? Math.round(b / 1024) + " KB" : "—");
const formatMB = (b) => (typeof b === "number" ? (b / 1048576).toFixed(1) + " MB" : "—");

function rssiQuality(rssi) {
  if (typeof rssi !== "number" || rssi === 0) return { label: "Unknown", tone: "idle" };
  if (rssi >= -60) return { label: "Excellent", tone: "good" };
  if (rssi >= -70) return { label: "Good", tone: "good" };
  if (rssi >= -80) return { label: "Fair", tone: "warn" };
  return { label: "Weak", tone: "bad" };
}


function drawChart(canvas, points, key, color, fixedMin, fixedMax) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;              

 
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "11px Segoe UI, sans-serif";

  if (points.length < 2) {
    ctx.fillStyle = "#495770";
    ctx.textAlign = "center";
    ctx.fillText("Collecting data…", w / 2, h / 2);
    return;
  }

  const values = points.map((p) => p[key]);

  
  let min = fixedMin !== undefined ? fixedMin : Math.min(...values);
  let max = fixedMax !== undefined ? fixedMax : Math.max(...values);
  if (max === min) { max += 1; min -= 1; }
  if (fixedMin === undefined || fixedMax === undefined) {
    const pad = (max - min) * 0.15;
    if (fixedMin === undefined) min -= pad;
    if (fixedMax === undefined) max += pad;
  }
  if (fixedMin === 0) min = 0;

 
  const left = 46, right = 12, top = 10, bottom = 22;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const xAt = (i) => left + (i / (points.length - 1)) * plotW;
  const yAt = (v) => top + (1 - (v - min) / (max - min)) * plotH;

  
  ctx.strokeStyle = "#492436";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#6b9674";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const y = yAt(v);
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = max - min < 10 ? v.toFixed(1) : Math.round(v);
    ctx.fillText(label, left - 6, y + 4);
  }

  
  ctx.textAlign = "left";
  ctx.fillText(points[0].time, left, h - 6);
  ctx.textAlign = "right";
  ctx.fillText(points[points.length - 1].time, w - right, h - 6);

  
  const gradient = ctx.createLinearGradient(0, top, 0, top + plotH);
  gradient.addColorStop(0, color + "70");
  gradient.addColorStop(1, color + "00");
  ctx.beginPath();
  ctx.moveTo(xAt(0), top + plotH);
  points.forEach((p, i) => ctx.lineTo(xAt(i), yAt(p[key])));
  ctx.lineTo(xAt(points.length - 1), top + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(xAt(i), yAt(p[key]));
    else ctx.lineTo(xAt(i), yAt(p[key]));
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();


  const last = points.length - 1;
  ctx.beginPath();
  ctx.arc(xAt(last), yAt(points[last][key]), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function redrawCharts() {
  drawChart($("chartRps"),  history, "rps",    "#108fc6", 0);
  drawChart($("chartHeap"), history, "heapKB", "#8b6ee1");
  drawChart($("chartRssi"), history, "rssi",   "#28cd64", -100, -20);
}


const BADGES = {
  loading:    { text: "⚪ CONNECTING…",   tone: "idle" },
  online:     { text: "🟢 ESP32 ONLINE",  tone: "good" },
  offline:    { text: "🔴 ESP32 OFFLINE", tone: "bad"  },
  restarting: { text: "🟡 RESTARTING…",   tone: "warn" },
};


function rowsHtml(rows) {
  return rows.map(([label, value]) =>
    '<div class="info-row"><span class="info-label">' + escapeHtml(label) +
    '</span><span class="info-value">' +
    escapeHtml(value === undefined || value === null ? "—" : value) +
    "</span></div>").join("");
}

function setStat(id, text, tone) {
  const el = $(id);
  el.textContent = text;
  el.className = "stat-value" + (tone ? " " + tone : "");
}

function renderConnection() {
  const badge = BADGES[connection] || BADGES.loading;
  $("badge").textContent = badge.text;
  $("badge").className = "badge " + badge.tone;

  const banner = $("banner");
  if (connection === "offline") {
    banner.className = "banner bad";
    banner.textContent = "🔴 ESP32 OFFLINE — cannot reach " + BASE_URL + ". Retrying every 3 s…";
  } else if (connection === "restarting") {
    banner.className = "banner warn";
    banner.textContent = "🟡 Restarting… waiting for the ESP32 to reboot and reconnect to Wi-Fi.";
  } else {
    banner.className = "banner hidden";
  }

  
  $("dashboard").classList.toggle("stale", connection === "offline" || connection === "restarting");

 
  const btn = $("restartBtn");
  btn.disabled = connection !== "online";
  btn.textContent = connection === "restarting" ? "⏳ Restarting..." : "🔄 RESTART ESP32";
}

function renderStats() {
  if (!status || !metrics) return;

  const stateMap = {
    online:     { text: "🟢 Healthy",    tone: "good" },
    offline:    { text: "🔴 Offline",    tone: "bad"  },
    restarting: { text: "🟡 Restarting", tone: "warn" },
  };
  const st = stateMap[connection] || stateMap.offline;
  setStat("statStatus", st.text, st.tone);
  $("statStatusSub").textContent = (status.requests ?? 0) + " requests served";

  setStat("statUptime", formatUptime(status.uptime));

  setStat("statMemory", formatKB(status.freeHeap));
  const total = metrics.totalHeap;
  $("statMemorySub").textContent = total > 0
    ? Math.round((status.freeHeap / total) * 100) + "% of " + formatKB(total) + " free"
    : "";

  const q = rssiQuality(status.wifiRSSI);
  setStat("statWifi", status.wifiRSSI + " dBm", q.tone);
  $("statWifiSub").textContent = "Signal: " + q.label;
}

function renderDetails() {
  if (!metrics) return;
  const m = metrics;
  const r = m.requests || {};
  const q = rssiQuality(m.wifiRSSI);

  $("networkRows").innerHTML = rowsHtml([
    ["IP address", m.ip],
    ["SSID", m.wifiSSID],
    ["RSSI", m.wifiRSSI + " dBm (" + q.label + ")"],
    ["MAC address", m.mac],
    ["HTTP requests", r.total],
    ["Successful", r.success],
    ["Errors (4xx/5xx)", r.errors],
    ["404 Not Found", r.notFound],
    ["Requests / second", r.perSecond],
  ]);

  $("deviceRows").innerHTML = rowsHtml([
    ["Chip", m.chipModel + " (rev " + m.chipRevision + ", " + m.chipCores + " core" + (m.chipCores > 1 ? "s" : "") + ")"],
    ["CPU frequency", m.cpuFrequency + " MHz"],
   
    ["CPU utilization", "Not measured (not exposed by Arduino core)"],
    ["Free heap", formatKB(m.freeHeap)],
    ["Total heap", formatKB(m.totalHeap)],
    ["Lowest free heap", formatKB(m.minFreeHeap)],
    ["Largest free block", formatKB(m.maxAllocHeap)],
    ["Flash size", formatMB(m.flashSize)],
    ["Sketch size", formatKB(m.sketchSize)],
    ["SDK version", m.sdkVersion],
  ]);
}

function renderChartsAndNotes() {
  if (history.length > 0) {
    const last = history[history.length - 1];
    $("rpsNow").textContent  = last.rps + " req/s";
    $("heapNow").textContent = last.heapKB + " KB";
    $("rssiNow").textContent = last.rssi + " dBm";
  }
  redrawCharts();
}

function renderLogs() {
  const box = $("logs");
  box.textContent = ""; 
  if (logs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-line";
    empty.textContent = "No logs yet.";
    box.appendChild(empty);
    return;
  }
  
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    const line = document.createElement("div");
    line.className = "log-line" + (String(log.message).includes("->") ? " error" : "");
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = "[" + log.time + "] ";
    line.appendChild(time);
    line.appendChild(document.createTextNode(log.message));
    box.appendChild(line);
  }
}

function renderWsState() {
  const pill = $("wsPill");
  pill.textContent = wsConnected ? "WebSocket: live" : "WebSocket: off";
  pill.className = "pill " + (wsConnected ? "good" : "idle");
  $("logsNote").textContent = wsConnected ? "● streaming via WebSocket" : "refreshed every 3 s";
}

function renderAll() {
  renderConnection();
  renderStats();
  renderDetails();
  renderChartsAndNotes();
  renderLogs();
  renderWsState();
}

function showNotice(type, text) {
  const n = $("notice");
  n.className = "notice " + type;
  n.textContent = text;
}


async function poll() {
  if (pollInFlight) return;          
  pollInFlight = true;

  
  if (restart.active && Date.now() - restart.startedAt > RESTART_WAIT_MS) {
    restart.active = false;
  }

  try {
   
    await getHealth();
    const s = await getStatus();
    const m = await getMetrics();
    const l = await getLogs();

    status = s;
    metrics = m;
    logs = Array.isArray(l && l.logs) ? l.logs : [];

    history.push({
      time: new Date().toLocaleTimeString(),
      rps: (m.requests && m.requests.perSecond) || 0,
      heapKB: Math.round((m.freeHeap || 0) / 1024),
      rssi: m.wifiRSSI || 0,
    });
    if (history.length > MAX_POINTS) history.shift();

    if (restart.active && !restart.sawOffline) {
      connection = "restarting";     
    } else {
      if (restart.active) showNotice("success", "ESP32 restarted and is back online.");
      restart.active = false;
      connection = "online";
    }
  } catch (err) {
    
    if (restart.active) {
      restart.sawOffline = true;
      connection = "restarting";
    } else {
      connection = "offline";
    }
    $("loadingText").textContent = err.message;
  } finally {
    pollInFlight = false;
  }

  showCorrectScreen();
  renderAll();
}


function showCorrectScreen() {
  const hasData = status && metrics;
 
  $("loading").classList.add("hidden");
  $("dashboard").classList.toggle("hidden", !hasData);
  $("emptyState").classList.toggle("hidden", !!hasData);
}


let socket = null;

function connectWebSocket() {
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    setTimeout(connectWebSocket, 5000);
    return;
  }

  socket.onopen = () => { wsConnected = true; renderWsState(); };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "log" && msg.data) {
        
        if (!logs.some((l) => l.id === msg.data.id)) {
          logs.push(msg.data);
          if (logs.length > MAX_LOGS) logs.shift();
          renderLogs();
        }
      } else if (msg.type === "metrics" && msg.data && status) {
       
        status = { ...status, ...msg.data };
        renderStats();
      }
    } catch (e) {
      
    }
  };

  socket.onclose = () => {
    wsConnected = false;
    renderWsState();
    setTimeout(connectWebSocket, 5000);   
  };

  socket.onerror = () => { try { socket.close(); } catch (e) {} };
}


async function handleRestart() {
  
  if (!window.confirm("Restart the ESP32? It will go offline for a few seconds.")) return;

  $("notice").className = "notice hidden";
  try {
    
    await postRestart();
    
    restart = { active: true, sawOffline: false, startedAt: Date.now() };
    connection = "restarting";
    showNotice("info", "Restart command sent. Waiting for the ESP32 to come back…");
    renderConnection();
  } catch (err) {
    showNotice("error", "Restart failed: " + err.message);
  }
}


$("deviceLabel").textContent = "Device: " + ESP32_IP;
$("loadingText").textContent = "Trying " + BASE_URL;
$("restartBtn").addEventListener("click", handleRestart);
window.addEventListener("resize", redrawCharts);

poll();                          
setInterval(poll, POLL_MS);      
connectWebSocket();              