import { useEffect, useState } from "react";

interface RankedModel {
  id: string;
  name: string;
  quality: number;
  cost: number;
  latency: number;
  score: number;
}

interface ModelsResponse {
  weights: { quality: number; cost: number; latency: number };
  selectedModelId: string;
  selectedModelName: string;
  ranking: RankedModel[];
  changed?: boolean;
}

// Redistribute so the three weights always sum to 100. When one slider moves,
// the other two absorb the difference proportionally to their current values.
function rebalance(
  changed: "quality" | "cost" | "latency",
  value: number,
  prev: { quality: number; cost: number; latency: number }
) {
  value = Math.max(0, Math.min(100, Math.round(value)));
  const others = (["quality", "cost", "latency"] as const).filter((k) => k !== changed);
  const remaining = 100 - value;
  const otherSum = prev[others[0]] + prev[others[1]];
  const next: any = { ...prev, [changed]: value };
  if (otherSum === 0) {
    next[others[0]] = Math.round(remaining / 2);
    next[others[1]] = remaining - next[others[0]];
  } else {
    next[others[0]] = Math.round((prev[others[0]] / otherSum) * remaining);
    next[others[1]] = remaining - next[others[0]];
  }
  return next;
}

export default function ModelSelector({ apiBase }: { apiBase: string }) {
  const [weights, setWeights] = useState({ quality: 50, cost: 25, latency: 25 });
  const [ranking, setRanking] = useState<RankedModel[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(apiBase + "/models");
      const data: ModelsResponse = await res.json();
      setWeights(data.weights);
      setRanking(data.ranking);
      setSelected(data.selectedModelName);
    } catch {
      setStatus("Could not load model preferences.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSlide(key: "quality" | "cost" | "latency", v: number) {
    setWeights((prev) => rebalance(key, v, prev));
  }

  async function apply() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(apiBase + "/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(weights),
      });
      const data: ModelsResponse & { error?: string } = await res.json();
      if (!res.ok) {
        setStatus("Error: " + (data.error || "unknown"));
      } else {
        setRanking(data.ranking);
        setSelected(data.selectedModelName);
        setStatus(
          data.changed
            ? `Live model switched to ${data.selectedModelName}.`
            : `Preferences applied. Best model remains ${data.selectedModelName}.`
        );
      }
    } catch (err: any) {
      setStatus("Request failed: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  const total = weights.quality + weights.cost + weights.latency;

  return (
    <section
      style={{
        marginTop: 28,
        padding: 18,
        borderRadius: 12,
        background: "#ffffff",
        border: "1px solid #d7deea",
      }}
    >
      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Bedrock model preferences</h2>
      <p style={{ color: "#5a6b80", margin: "0 0 14px", fontSize: 14 }}>
        Adjust the priorities below and apply. The best-matching Bedrock model becomes the live
        inference model for recommendation explanations. Weights always total 100%.
      </p>

      {(["quality", "cost", "latency"] as const).map((k) => (
        <div key={k} style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
            <label htmlFor={k} style={{ textTransform: "capitalize" }}>
              {k}
            </label>
            <strong>{weights[k]}%</strong>
          </div>
          <input
            id={k}
            type="range"
            min={0}
            max={100}
            value={weights[k]}
            onChange={(e) => onSlide(k, Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
        <button
          onClick={apply}
          disabled={busy || total !== 100}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "none",
            background: "#2563eb",
            color: "#fff",
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Applying..." : "Apply preferences"}
        </button>
        <span style={{ fontSize: 13, color: total === 100 ? "#3a7d44" : "#b4232a" }}>
          total: {total}%
        </span>
        {status && <span style={{ fontSize: 13, color: "#5a6b80" }}>{status}</span>}
      </div>

      <h3 style={{ fontSize: 15, margin: "18px 0 8px" }}>Model ranking for current preferences</h3>
      <div style={{ display: "grid", gap: 6 }}>
        {ranking.map((m, i) => {
          const isSelected = m.name === selected;
          return (
            <div
              key={m.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                borderRadius: 8,
                background: isSelected ? "#e8f0ff" : "#f4f6fb",
                border: isSelected ? "1px solid #2563eb" : "1px solid #e2e8f2",
              }}
            >
              <span>
                <strong style={{ marginRight: 8 }}>#{i + 1}</strong>
                {m.name}
                {isSelected && (
                  <span style={{ marginLeft: 8, color: "#2563eb", fontSize: 12, fontWeight: 600 }}>
                    ● LIVE
                  </span>
                )}
              </span>
              <span style={{ fontSize: 13, color: "#5a6b80" }}>
                score {m.score.toFixed(3)} · Q{m.quality} C{m.cost} L{m.latency}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
