import { useState } from "react";
import { useRouter } from "next/router";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName, mode }),
    });
    setBusy(false);
    if (res.ok) {
      router.push("/");
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Something went wrong");
    }
  }

  const isRegister = mode === "register";

  return (
    <main style={{ maxWidth: 380, margin: "80px auto", padding: 24 }}>
      <h1 style={{ fontSize: 24 }}>Personalization Hub</h1>
      <p style={{ color: "#9fb0c3" }}>GoTo Learning Center</p>

      <h2 style={{ fontSize: 18, marginTop: 24, marginBottom: 0 }}>
        {isRegister ? "Create your account" : "Sign in"}
      </h2>

      <form onSubmit={submit} style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {isRegister && (
          <input
            type="text"
            placeholder="display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            style={inputStyle}
          />
        )}
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          style={inputStyle}
        />
        {error && <div style={{ color: "#ff7b7b" }}>{error}</div>}
        <button type="submit" disabled={busy} style={buttonStyle}>
          {busy ? "..." : isRegister ? "Create account" : "Log in"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(isRegister ? "login" : "register");
          setError(null);
        }}
        style={{ marginTop: 16, background: "none", border: "none", color: "#6ea8fe", cursor: "pointer", padding: 0 }}
      >
        {isRegister ? "Have an account? Sign in" : "Need an account? Register"}
      </button>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 8,
  border: "1px solid #2a3346",
  background: "#161c2b",
  color: "#e7ecf3",
};

const buttonStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "white",
  fontWeight: 600,
  cursor: "pointer",
};
