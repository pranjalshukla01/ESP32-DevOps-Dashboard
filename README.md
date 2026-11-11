# ESP32 DevOps Dashboard

A mini DevOps monitoring dashboard for the ESP32. The board runs its own web server (REST API + WebSocket), and a plain HTML/CSS/JavaScript dashboard on your laptop shows live data over Wi-Fi.

## Features

- Live uptime, free heap, Wi-Fi SSID/RSSI, IP, MAC and chip info, all read from the real device
- Request stats: total, successful, errors, 404s, requests per second
- Live charts for requests/s, free heap and Wi-Fi signal
- Rolling request log (ring buffer on the ESP32)
- Online/offline detection that recovers automatically
- Remote restart button, protected by an API key
- WebSocket live updates, with REST polling as the primary data source

> CPU **frequency** is shown, not CPU usage. The Arduino core doesn't expose utilization, so it is not faked.

## Architecture

```text
Dashboard (browser)
      ↓  REST (port 80) + WebSocket (port 81)
    Wi-Fi
      ↓
ESP32 WebServer + WebSocketsServer
      ↓
ESP32 system APIs (heap, CPU, Wi-Fi, chip info)
```

## Project structure

```text
esp32-devops-dashboard/
├── esp32/esp32_devops_dashboard/esp32_devops_dashboard.ino
└── frontend/
    ├── index.html
    ├── style.css
    └── script.js
```

## Requirements

- ESP32 board and a data-capable USB cable
- Arduino IDE with **esp32 by Espressif Systems** installed (Boards Manager)
- Library: **WebSockets by Markus Sattler** (Library Manager)
- VS Code with the **Live Server** extension (or just open `index.html`)
- A **2.4 GHz** Wi-Fi network. The laptop and the ESP32 must be on the **same** network.

## Setup

**1. Flash the ESP32**

Open the `.ino` file and edit the top:

```cpp
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* API_KEY       = "esp32-secret";   
```

Select **ESP32 Dev Module** and your COM port, then upload. Open the Serial Monitor at **115200 baud** and note the printed IP address.

**2. Configure the dashboard**

Edit the top of `frontend/script.js`:

```javascript
const ESP32_IP = "192.168.1.42";   
const API_KEY  = "esp32-secret";   
```

**3. Run it**

Right-click `frontend/index.html` in VS Code and choose **Open with Live Server**. Use `http://`, not `https://`.

## API

| Method | Route | Description |
|---|---|---|
| GET | `/` | Simple status page |
| GET | `/health` | `{"status":"ok"}` |
| GET | `/api/status` | Uptime, heap, CPU frequency, RSSI, IP, requests |
| GET | `/api/metrics` | Full system and request metrics |
| GET | `/api/logs` | Recent logs (oldest first) |
| POST | `/api/restart` | Restarts the ESP32. Needs the header `X-Api-Key` |

Error codes: `400` missing API key, `401` wrong key, `404` unknown route, `405` wrong method, `500` internal error.

## Quick test

```bash
curl.exe http://<esp32-ip>/health
curl.exe -X POST http://<esp32-ip>/api/restart                       # 400
curl.exe -X POST -H "X-Api-Key: wrong" http://<esp32-ip>/api/restart  # 401
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard says OFFLINE | Check `ESP32_IP`, and that laptop and ESP32 share the same network (first three IP numbers should match in `ipconfig`) |
| ESP32 won't connect to Wi-Fi | Use a 2.4 GHz network and re-check the SSID and password (case-sensitive) |
| Upload hangs on "Connecting..." | Hold the **BOOT** button, use a data cable, close the Serial Monitor |
| COM port missing | Install the CP210x or CH340 driver, try another cable or port |
| Works on a hotspot but not on another Wi-Fi | The network may use client isolation. Use a hotspot or a home router |
| WebSocket shows "off" | Install the WebSockets library and check that port 81 isn't blocked. REST still works |
| Unstyled page | `style.css` and `script.js` must sit next to `index.html` |

## Security notes

This is a **local-network learning project**.

- Plain HTTP is unencrypted, so anyone on your Wi-Fi can read the traffic, including the API key.
- The API key sits in `script.js`, so it is not real authentication.
- CORS is open (`*`) so the dashboard can reach the board.
- Never expose the ESP32 to the internet or port-forward it.
- Never commit real Wi-Fi credentials.

## What I learned

REST APIs on a microcontroller, CORS, ring buffers, WebSockets, graceful offline handling, and debugging a laptop and device on different subnets.

## License

MIT
