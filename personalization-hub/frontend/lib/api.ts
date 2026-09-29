// Internal base URL for backend services, reached via the ALB from within the VPC.
// Set to the ALB DNS at deploy time. Server-side only.
export const INTERNAL_API =
  process.env.INTERNAL_API_URL || "http://localhost:8080";

export interface RecommendedItem {
  itemId: string;
  title: string;
  score: number;
  reason: string;
}

export interface RecommendationResponse {
  userId: string;
  strategy: "rule-based" | "ml-based";
  experimentVariant: string | null;
  items: RecommendedItem[];
}

export async function fetchRecommendations(
  token: string,
  limit = 10
): Promise<RecommendationResponse | null> {
  try {
    const res = await fetch(`${INTERNAL_API}/api/recommendations?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as RecommendationResponse;
  } catch {
    return null;
  }
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export async function fetchProfile(token: string): Promise<PublicUser | null> {
  try {
    const res = await fetch(`${INTERNAL_API}/api/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user as PublicUser;
  } catch {
    return null;
  }
}
