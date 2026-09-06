# Reporting and metric interpretation

The portfolio summary groups pull requests whose creation, update, merge, or close timestamp falls inside the selected window.

Per-author fields mean:

- `touchedPullRequests`: PRs with activity in the window and currently attributed to the author.
- `opened` and `merged`: PR lifecycle events whose timestamps fall inside the window.
- `reviewsSubmitted`: review records submitted inside the window.
- `additions`, `deletions`, `changedFiles`, and `commits`: GitHub's current totals for those active PRs, not a time-sheet delta.

Long-lived PRs may appear in more than one report when they remain active. Rebase and force-push activity can also change totals. Use these facts to locate review load, delivery concentration, oversized PRs, or assignment gaps. Do not convert them directly into ranking, compensation, promotion, or disciplinary decisions. Pair them with delivered outcomes, defect history, review quality, support load, complexity, and the person's agreed responsibility.
