// CONFIG is injected via config.js (written at deploy time by CDK).
const API = (window.CONFIG && window.CONFIG.apiBase) || "";

const chatEl = document.getElementById("chat");
const form = document.getElementById("chat-form");
const input = document.getElementById("question");
const askBtn = document.getElementById("ask-btn");
const logsEl = document.getElementById("logs");
const refreshBtn = document.getElementById("refresh-logs");
document.getElementById("config-note").textContent = API
  ? "Connected to insights API."
  : "API base not configured.";

function addMsg(text, who, meta) {
  const div = document.createElement("div");
  div.className = "msg " + who;
  div.textContent = text;
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    div.appendChild(m);
  }
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

addMsg(
  "Hi! I can explain how the Personalization Hub was designed and deployed, and show you live LLM reasoning logs. What would you like to know?",
  "bot"
);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  addMsg(q, "user");
  input.value = "";
  askBtn.disabled = true;
  const thinking = document.createElement("div");
  thinking.className = "msg bot";
  thinking.textContent = "Thinking...";
  chatEl.appendChild(thinking);
  try {
    const res = await fetch(API + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    const data = await res.json();
    thinking.remove();
    if (data.answer) {
      const meta = `model: ${data.model} · ${data.latencyMs}ms${data.logsIncluded ? " · included logs" : ""}`;
      addMsg(data.answer, "bot", meta);
    } else {
      addMsg("Error: " + (data.error || "unknown"), "bot");
    }
  } catch (err) {
    thinking.remove();
    addMsg("Request failed: " + err.message, "bot");
  } finally {
    askBtn.disabled = false;
  }
});

async function loadLogs() {
  logsEl.innerHTML = "<div class='hint'>Loading...</div>";
  try {
    const res = await fetch(API + "/logs");
    const data = await res.json();
    logsEl.innerHTML = "";
    if (!data.events || data.events.length === 0) {
      logsEl.innerHTML = "<div class='hint'>No reasoning logs yet. Generate recommendations or ask the chatbot a question.</div>";
      return;
    }
    for (const ev of data.events) {
      const item = document.createElement("div");
      item.className = "log-item";
      const comp = document.createElement("div");
      comp.className = "comp";
      comp.textContent = ev.component || ev.group || "log";
      item.appendChild(comp);
      const prompt = ev.question || ev.user_prompt;
      if (prompt) {
        const q = document.createElement("div");
        q.className = "q";
        q.textContent = "Prompt: " + String(prompt).slice(0, 300);
        item.appendChild(q);
      }
      if (ev.response) {
        const r = document.createElement("div");
        r.className = "r";
        r.textContent = "Response: " + String(ev.response).slice(0, 400);
        item.appendChild(r);
      }
      if (ev.error) {
        const r = document.createElement("div");
        r.className = "r";
        r.textContent = "Error: " + ev.error;
        item.appendChild(r);
      }
      const stat = document.createElement("div");
      stat.className = "stat";
      const parts = [];
      if (ev.model_id) parts.push(ev.model_id);
      if (typeof ev.latency_ms === "number") parts.push(ev.latency_ms + "ms");
      if (typeof ev.input_tokens === "number") parts.push("in " + ev.input_tokens + "tok");
      if (typeof ev.output_tokens === "number") parts.push("out " + ev.output_tokens + "tok");
      stat.textContent = parts.join(" · ");
      item.appendChild(stat);
      logsEl.appendChild(item);
    }
  } catch (err) {
    logsEl.innerHTML = "<div class='hint'>Failed to load logs: " + err.message + "</div>";
  }
}

refreshBtn.addEventListener("click", loadLogs);
loadLogs();
