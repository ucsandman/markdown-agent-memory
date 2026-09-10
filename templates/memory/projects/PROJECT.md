# Example App

One file per project. Current truth is the un-struck line; history stays above it, struck through and dated.

## Status

- [observed] Deployed on Vercel, production URL live. Verified 2026-03-10.

## Decisions

- ~~[stated] Public API is REST.~~ superseded 2026-04-12 (architecture meeting)
- ~~[stated] Public API is GraphQL.~~ superseded 2026-08-20 (Q3 platform review)
- [stated] Public API is tRPC, decided in the Q3 platform review. (2026-08-20)

## Facts

- [observed] Repo: github.com/alexdev/example-app, default branch `main`. (2026-02-01)
- [stated] Postgres on Neon; no schema migrations without explicit approval. (2026-02-14)
- [inferred] Test suite is the release gate in practice — every ship this quarter waited on green tests (2026-06-30).

## Open Loops

- [stated] Billing page redesign parked until the pricing decision lands. (2026-08-25)
