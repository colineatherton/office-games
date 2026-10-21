# 💡 Game ideas backlog

Games for the monthly social hour. All buildable as static pages on GitHub Pages,
synced through the same Firebase Realtime Database. Checked = built.

- [x] **🎨 Pictionary** — Red vs Blue, rotating drawers, live canvas, team scoring.
- [x] **📞 Drawing Telephone** (Gartic Phone clone) — everyone writes a prompt →
  draws someone else's prompt → describes someone else's drawing → draws that
  description… then the full chains are revealed one step at a time. Reuses the
  Pictionary canvas. Consistently the funniest game on video calls.
- [ ] **🧠 Team quiz buzzer** — host reads (or screen shows) questions, first team
  to buzz gets to answer. The buzzer race over a shared DB is hilarious, with
  built-in network-latency excuses. Could add host-written question packs stored
  in the DB so anyone can prep a round.
- [ ] **🕵️ Codenames-style word grid** — 25 words on a grid, each team has a
  clue-giver who sees the key card (which words belong to which team), teams
  guess from one-word clues. Perfect team-vs-team, very little UI needed.
- [ ] **🤥 Fibbage / Balderdash** — everyone submits a fake answer to an obscure
  question, then votes on which answer is the real one. Points for fooling
  people and for finding the truth. Great for big groups, zero drawing skill
  needed.
- [ ] **🎬 Emoji movie/song guesser** — one player builds an emoji string
  (🦁👑 = Lion King), teams race to guess in chat. Trivially easy to build:
  it's Pictionary with an emoji picker instead of a canvas.
- [ ] **🟩 Collaborative Wordle race** — both teams get the same hidden word,
  teammates take turns submitting guesses, first team to solve wins the point.
  Best of 5.

## Smaller enhancement ideas

- Custom word lists per room (let the host paste in-jokes before starting Pictionary).
- Drawing replay animation during the Telephone reveal (strokes are already vector
  data in Pictionary — store strokes instead of PNGs and replay them).
- Persistent team leaderboard across game nights (one DB node, tiny page).
- Sound effects (correct guess ding, time-running-out tick).
