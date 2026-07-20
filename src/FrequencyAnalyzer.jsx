/**
 * FrequencyAnalyzer.jsx
 * ---------------------
 * React frontend scaffold for the real-time FFT audio analyzer.
 * 
 * - Captures mic via Web Audio API
 * - Streams raw audio chunks to FastAPI backend via WebSocket
 * - Renders live FFT waveform on canvas
 * - Displays frequency detections returned from backend
 * - Gracefully falls back to local FFT display if backend is unavailable
 * 
 * Setup:
 *   npm create vite@latest fft-frontend -- --template react
 *   cd fft-frontend
 *   npm install
 *   cp FrequencyAnalyzer.jsx src/App.jsx
 *   npm run dev
 */

import { useState, useEffect, useRef, useCallback } from "react";

const WS_DEFAULT_URL = "ws://localhost:8000/ws/audio";

const MOCK_DETECTIONS = [
  { label: "417Hz Sacral Chakra",        pct: 35.3, color: "#f97316" },
  { label: "285Hz Tissue Healing",        pct: 17.6, color: "#22c55e" },
  { label: "528Hz Solfeggio",             pct: 14.7, color: "#22c55e" },
  { label: "432Hz Heart Chakra",          pct: 11.8, color: "#22c55e" },
  { label: "320Hz Solar Plexus",          pct: 8.8,  color: "#eab308" },
  { label: "136.1Hz OM Resonance",        pct: 5.9,  color: "#a855f7" },
  { label: "215Hz Emotional Clearing",    pct: 2.9,  color: "#06b6d4" },
  { label: "396Hz Solfeggio Liberation",  pct: 2.9,  color: "#ef4444" },
];

// ─── Idle animation (pulsing rings) ──────────────────────────────────────────
function drawIdle(ctx, canvas, timestamp) {
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);
  const t = timestamp / 1000;
  const cx = w / 2;
  const cy = h / 2;

  for (let i = 0; i < 4; i++) {
    const r = 16 + i * 20 + Math.sin(t * 1.4 + i * 0.8) * 5;
    const alpha = 0.18 - i * 0.04;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(139, 92, 246, ${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(139, 92, 246, 0.5)";
  ctx.fill();
}

// ─── FFT bar visualizer ───────────────────────────────────────────────────────
function drawFFT(ctx, canvas, dataArray) {
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);

  const bars = dataArray.length;
  const barW = w / bars;

  for (let i = 0; i < bars; i++) {
    const v = dataArray[i] / 255;
    const barH = v * h * 0.92;
    const hue = 260 + v * 80;
    ctx.fillStyle = `hsla(${hue}, 65%, 58%, ${0.35 + v * 0.65})`;
    ctx.fillRect(i * barW, h - barH, Math.max(barW - 1, 1), barH);
  }
}

// ─── Detection row component ──────────────────────────────────────────────────
function DetectionRow({ label, pct, color }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "7px 0",
      borderBottom: "0.5px solid rgba(255,255,255,0.07)",
      fontSize: 13,
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: "50%",
        background: color || "#8b5cf6", flexShrink: 0,
      }} />
      <span style={{ flex: 1, color: "#e2e8f0" }}>{label}</span>
      <div style={{
        width: 90, height: 5,
        background: "rgba(255,255,255,0.08)",
        borderRadius: 3, overflow: "hidden",
      }}>
        <div style={{
          height: "100%", borderRadius: 3,
          width: `${Math.min(pct, 100)}%`,
          background: color || "#8b5cf6",
          transition: "width 0.35s ease",
        }} />
      </div>
      <span style={{
        fontSize: 12, color: "#94a3b8",
        minWidth: 38, textAlign: "right",
        fontFamily: "monospace",
      }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Status pill ──────────────────────────────────────────────────────────────
function StatusPill({ status }) {
  const styles = {
    idle:        { bg: "rgba(255,255,255,0.06)", color: "#94a3b8", border: "rgba(255,255,255,0.1)" },
    connected:   { bg: "rgba(34,197,94,0.12)",  color: "#4ade80", border: "rgba(34,197,94,0.3)"  },
    error:       { bg: "rgba(239,68,68,0.12)",  color: "#f87171", border: "rgba(239,68,68,0.3)"  },
    listening:   { bg: "rgba(139,92,246,0.12)", color: "#c084fc", border: "rgba(139,92,246,0.3)" },
  };
  const s = styles[status.type] || styles.idle;
  return (
    <span style={{
      fontSize: 12, padding: "4px 10px", borderRadius: 99,
      background: s.bg, color: s.color,
      border: `0.5px solid ${s.border}`,
    }}>
      {status.label}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function FrequencyAnalyzer() {
  const canvasRef      = useRef(null);
  const audioCtxRef    = useRef(null);
  const analyserRef    = useRef(null);
  const sourceRef      = useRef(null);
  const streamRef      = useRef(null);
  const wsRef          = useRef(null);
  const animFrameRef   = useRef(null);
  const isListeningRef = useRef(false);

  const [listening,   setListening]   = useState(false);
  const [detections,  setDetections]  = useState([]);
  const [wsUrl,       setWsUrl]       = useState(WS_DEFAULT_URL);
  const [status,      setStatus]      = useState({ type: "idle", label: "Not connected" });

  // ── Canvas setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
    }
    resize();
    window.addEventListener("resize", resize);

    // idle animation loop
    let frame;
    function idleLoop(ts) {
      if (isListeningRef.current) return;
      const ctx = canvas.getContext("2d");
      drawIdle(ctx, canvas, ts);
      frame = requestAnimationFrame(idleLoop);
    }
    frame = requestAnimationFrame(idleLoop);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(frame);
    };
  }, []);

  // ── Stop listening ──────────────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    setListening(false);

    cancelAnimationFrame(animFrameRef.current);

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    sourceRef.current  = null;
    analyserRef.current = null;
    setDetections([]);
    setStatus({ type: "idle", label: "Not connected" });

    // restart idle animation
    const canvas = canvasRef.current;
    if (!canvas) return;
    function idleLoop(ts) {
      if (isListeningRef.current) return;
      const ctx = canvas.getContext("2d");
      drawIdle(ctx, canvas, ts);
      animFrameRef.current = requestAnimationFrame(idleLoop);
    }
    animFrameRef.current = requestAnimationFrame(idleLoop);
  }, []);

  // ── Start listening ─────────────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    // 1. Request mic
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      setStatus({ type: "error", label: "Mic permission denied" });
      return;
    }

    // 2. Set up Web Audio
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 512;

    const source = audioCtx.createMediaStreamSource(micStream);
    source.connect(analyser);

    streamRef.current   = micStream;
    audioCtxRef.current = audioCtx;
    analyserRef.current = analyser;
    sourceRef.current   = source;

    // 3. Connect WebSocket
    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onopen  = () => setStatus({ type: "connected",  label: "Backend connected" });
      ws.onerror = () => setStatus({ type: "error",      label: "WS error — local FFT only" });
      ws.onclose = () => setStatus({ type: "listening",  label: "Listening (no backend)" });

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (Array.isArray(data.detections)) {
            setDetections(data.detections);
          }
        } catch {
          // ignore malformed messages
        }
      };

      wsRef.current = ws;
    } catch {
      setStatus({ type: "listening", label: "Listening (no backend)" });
    }

    // 4. Start render loop
    isListeningRef.current = true;
    setListening(true);
    setStatus(prev => prev.type === "idle"
      ? { type: "listening", label: "Listening..." }
      : prev
    );

    const canvas   = canvasRef.current;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    function loop() {
      if (!isListeningRef.current) return;

      analyser.getByteFrequencyData(dataArray);
      const ctx = canvas.getContext("2d");
      drawFFT(ctx, canvas, dataArray);

      // Send raw audio to backend if WebSocket is open
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(dataArray.buffer);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    }

    cancelAnimationFrame(animFrameRef.current);
    loop();

    // TEMP: show mock detections after 1.5s until backend is wired
    setTimeout(() => {
      if (isListeningRef.current && wsRef.current?.readyState !== WebSocket.OPEN) {
        setDetections(MOCK_DETECTIONS);
      }
    }, 1500);

  }, [wsUrl]);

  const toggleListen = useCallback(() => {
    if (listening) stopListening();
    else startListening();
  }, [listening, startListening, stopListening]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh",
      background: "#0b0b12",
      fontFamily: "'Inter', system-ui, sans-serif",
      color: "#e2e8f0",
      padding: "2rem 1.5rem",
    }}>
      <div style={{ maxWidth: 680, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: "1.75rem" }}>
          <h1 style={{
            fontFamily: "Georgia, serif",
            fontSize: 26, fontWeight: 400,
            color: "#f1f5f9", margin: 0,
          }}>
            Frequency Analyzer
          </h1>
          <p style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
            Real-time chakra & solfeggio detection
          </p>
        </div>

        {/* Visualizer card */}
        <div style={{
          background: "#13131f",
          border: "0.5px solid rgba(255,255,255,0.08)",
          borderRadius: 12, padding: "1.25rem",
          marginBottom: "1rem",
        }}>
          <div style={{
            position: "relative", width: "100%", height: 160,
            borderRadius: 8, overflow: "hidden",
            background: "#0b0b12",
            border: "0.5px solid rgba(255,255,255,0.06)",
            marginBottom: "1rem",
          }}>
            <canvas
              ref={canvasRef}
              style={{ display: "block", width: "100%", height: "100%" }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={toggleListen}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "0 1.25rem", height: 40,
                borderRadius: 8, border: "none",
                fontSize: 14, fontWeight: 500,
                cursor: "pointer",
                background: listening ? "rgba(239,68,68,0.15)" : "#7c3aed",
                color: listening ? "#f87171" : "#fff",
                outline: listening ? "0.5px solid rgba(239,68,68,0.3)" : "none",
                transition: "all 0.15s",
              }}
            >
              {listening ? (
                <>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: "#f87171",
                    animation: "pulse 1s infinite",
                  }} />
                  Stop listening
                </>
              ) : (
                <>🎙 Start listening</>
              )}
            </button>

            <StatusPill status={status} />
          </div>
        </div>

        {/* Detections */}
        <div style={{
          background: "#13131f",
          border: "0.5px solid rgba(255,255,255,0.08)",
          borderRadius: 12, padding: "1.25rem",
          marginBottom: "1rem",
        }}>
          <p style={{
            fontSize: 11, fontWeight: 500, color: "#475569",
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginBottom: "0.75rem",
          }}>
            Live detections
          </p>

          {detections.length === 0 ? (
            <div style={{ textAlign: "center", padding: "1.5rem", color: "#475569", fontSize: 13 }}>
              {listening ? "Listening… no detections yet" : "Start listening to see frequency detections"}
            </div>
          ) : (
            detections.map((d, i) => (
              <DetectionRow key={i} label={d.label} pct={d.pct} color={d.color} />
            ))
          )}
        </div>

        {/* WebSocket config */}
        <div style={{
          background: "#13131f",
          border: "0.5px solid rgba(255,255,255,0.08)",
          borderRadius: 12, padding: "1.25rem",
        }}>
          <p style={{
            fontSize: 11, fontWeight: 500, color: "#475569",
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginBottom: "0.75rem",
          }}>
            Backend endpoint
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={wsUrl}
              onChange={e => setWsUrl(e.target.value)}
              disabled={listening}
              style={{
                flex: 1, height: 36, borderRadius: 8,
                border: "0.5px solid rgba(255,255,255,0.1)",
                background: "#0b0b12", color: "#94a3b8",
                padding: "0 10px", fontSize: 13,
                fontFamily: "monospace",
                opacity: listening ? 0.5 : 1,
              }}
            />
          </div>
          <p style={{ fontSize: 12, color: "#334155", marginTop: 8 }}>
            FastAPI WebSocket backend — run <code style={{ color: "#7c3aed" }}>uvicorn main:app --reload</code> to connect
          </p>
        </div>

      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
