import type { GetServerSideProps } from "next";
import {
  RecommendationResponse,
  PublicUser,
  fetchProfile,
  fetchRecommendations,
} from "../lib/api";
import ModelSelector from "../components/ModelSelector";

interface HomeProps {
  user: PublicUser;
  recommendations: RecommendationResponse | null;
  insightsUrl: string | null;
  modelsApiUrl: string | null;
}

export const getServerSideProps: GetServerSideProps<HomeProps> = async (ctx) => {
  const token = ctx.req.cookies["auth_token"];
  if (!token) {
    return { redirect: { destination: "/login", permanent: false } };
  }
  const user = await fetchProfile(token);
  if (!user) {
    return { redirect: { destination: "/login", permanent: false } };
  }
  const recommendations = await fetchRecommendations(token, 10);
  const insightsUrl = process.env.INSIGHTS_URL || null;
  const modelsApiUrl = process.env.MODELS_API_URL || null;
  return { props: { user, recommendations, insightsUrl, modelsApiUrl } };
};

export default function Home({ user, recommendations, insightsUrl, modelsApiUrl }: HomeProps) {
  return (
    <main style={{ maxWidth: 820, margin: "40px auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0 }}>Recommended for you</h1>
          <p style={{ color: "#5a6b80", margin: "4px 0 0" }}>Welcome, {user.displayName}</p>
          {insightsUrl && (
            <p style={{ margin: "8px 0 0" }}>
              <a href={insightsUrl} target="_blank" rel="noopener noreferrer">
                Class Insights &amp; Chatbot →
              </a>
            </p>
          )}
        </div>
        {recommendations && (
          <span
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              background: recommendations.strategy === "rule-based" ? "#e3f0e6" : "#e3ecff",
              border: "1px solid #d7deea",
              fontSize: 13,
            }}
          >
            strategy: {recommendations.strategy}
            {recommendations.experimentVariant ? ` · ${recommendations.experimentVariant}` : ""}
          </span>
        )}
      </header>

      <section style={{ display: "grid", gap: 12, marginTop: 24 }}>
        {recommendations && recommendations.items.length > 0 ? (
          recommendations.items.map((item) => (
            <article
              key={item.itemId}
              style={{
                padding: 16,
                borderRadius: 12,
                background: "#ffffff",
                border: "1px solid #d7deea",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{item.title}</strong>
                <span style={{ color: "#5a6b80", fontSize: 13 }}>score {item.score.toFixed(3)}</span>
              </div>
              <div style={{ color: "#5a6b80", fontSize: 13, marginTop: 6 }}>{item.reason}</div>
            </article>
          ))
        ) : (
          <p style={{ color: "#5a6b80" }}>
            No recommendations yet. Interact with content to build your profile.
          </p>
        )}
      </section>

      {modelsApiUrl && <ModelSelector apiBase={modelsApiUrl} />}
    </main>
  );
}
