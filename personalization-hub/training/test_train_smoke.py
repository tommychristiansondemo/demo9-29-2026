"""Smoke test for ALS training math (no AWS/DB needed)."""
import numpy as np

from train import build_matrix, train_als, recall_at_k


def test_als_learns_structure():
    # Two clusters of users who like disjoint item sets.
    interactions = []
    for u in range(6):
        liked = range(0, 3) if u < 3 else range(3, 6)
        for i in liked:
            interactions.append((f"u{u}", f"i{i}", 5.0))
    user_index, item_index, R = build_matrix(interactions)
    U, V = train_als(R, num_factors=8, iterations=20)
    assert np.all(np.isfinite(U))
    assert np.all(np.isfinite(V))
    # Model should recall training positives well.
    assert recall_at_k(U, V, R, k=3) > 0.8


if __name__ == "__main__":
    test_als_learns_structure()
    print("OK")
