# Decision: CI-only deploys

- **Date:** 2026-01-30
- **Decided by:** Alex — [stated] "no more deploying from your machine, everything goes through CI"
- **Supersedes:** manual `vercel --prod` deploys
- **Reason:** two manual deploys shipped untested changes in January
- **Review trigger:** revisit if CI pipeline latency exceeds 15 minutes
- **valid_as_of:** 2026-03-10 (last confirmed still in force)

## History

- ~~Manual deploys allowed for hotfixes.~~ superseded 2026-01-30
