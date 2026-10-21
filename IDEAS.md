# 💡 Game ideas backlog

Games for the monthly social hour. All buildable as static pages on GitHub Pages,
synced through the same Firebase Realtime Database. Checked = built.

- [x] **🎨 Pictionary** — Red vs Blue, rotating drawers, live canvas, team scoring.
- [x] **📞 Drawing Telephone** (Gartic Phone clone) — everyone writes a prompt →
  draws someone else's prompt → describes someone else's drawing → draws that
  description… then the full chains are revealed one step at a time. Reuses the
  Pictionary canvas. Consistently the funniest game on video calls.
- [x] **🧠 Team quiz buzzer** — host reads (or screen shows) questions, first team
  to buzz gets to answer. The buzzer race over a shared DB is hilarious, with
  built-in network-latency excuses. Could add host-written question packs stored
  in the DB so anyone can prep a round.
- [x] **🕵️ Codenames-style word grid** — 25 words on a grid, each team has a
  clue-giver who sees the key card (which words belong to which team), teams
  guess from one-word clues. Perfect team-vs-team, very little UI needed.
- [x] **🤥 Fibbage / Balderdash** — everyone submits a fake answer to an obscure
  question, then votes on which answer is the real one. Points for fooling
  people and for finding the truth. Great for big groups, zero drawing skill
  needed.
- [x] **🎬 Emoji movie/song guesser** — one player builds an emoji string
  (🦁👑 = Lion King), teams race to guess in chat. Trivially easy to build:
  it's Pictionary with an emoji picker instead of a canvas.
- [x] **🌍 Polyglot** — a shared board of foreign-language word tiles (language
  labelled, meaning hidden); tiles group into sets that mean the same thing
  (perro / chien / hund / cane = dog). Teams race to click matching pairs;
  correct pairs are claimed in team colors, wrong guesses lock your team out
  for a few seconds. Cognates as bait. Most tiles after N rounds wins.
- [x] **🟩 Collaborative Wordle race** — both teams get the same hidden word,
  teammates take turns submitting guesses, first team to solve wins the point.
  Best of 5.
- [x] **🐸 Frogger Rush** — everyone plays Frogger simultaneously on the same
  deterministic traffic (shared seed, so lag can't kill you); every crossing
  scores for your team, ghosts of everyone's frogs visible live.
- [x] **🎤 Finish the Line** — famous song titles with a missing word, everyone
  types the answer against the clock. Built-in pack is titles only (lyric lines
  are copyrighted); host can add custom fill-in-the-blank questions in the lobby.

## Next wave — suggested 2026-10

- [ ] **🐑 Herd Mentality** — a prompt like "best biscuit?" or "most overrated
  film?"; everyone answers secretly; you score only if your answer matches the
  majority. No right answers, no content to author — the players are the content.
  The office argument generator.
- [ ] **🕵️‍♂️ Spyfall** — everyone is dealt the same location (beach, space
  station, kitchen…) except one spy who gets nothing. Players interrogate each
  other out loud on the call; the spy bluffs; vote the spy out, spy wins by
  guessing the location. Needs only a location list.
- [ ] **🔗 Connections** — NYT-style: 16 words hiding 4 groups of 4, teams race
  to find the groups with 4 strikes each. We author the puzzle packs (in-joke
  packs would be lethal).
- [ ] **😏 Two Truths and a Lie** — the app collects 2 truths + 1 lie from each
  player in the lobby, then runs a round per player: everyone votes on the lie,
  points for fooling and detecting. Best new-joiner icebreaker.
- [ ] **🔤 Letters Round** — Countdown-style: 9 random letters (pick vowel/
  consonant), longest valid word in 30s, dictionary-checked, team scores.
- [ ] **🔢 Numbers Round** — Countdown maths: 6 numbers, a target, 60s; type an
  expression, the app validates it; closest team scores.
- [ ] **🎲 Wits & Wagers** — a numeric question nobody knows exactly ("how long
  is the Great Wall of China?"); everyone estimates, estimates are lined up, then
  everyone bets on which is closest-without-going-over. Estimation + gambling.
- [ ] **🏁 Typing Grand Prix** — same (original, non-copyrighted) paragraph for
  all; live progress bars per player; team relay scoring. Instant chaos.
- [ ] **🚩 Flag Zoom** — an emoji flag rendered huge but heavily pixelated/
  blurred, sharpening over 20 seconds; first team to name the country scores —
  earlier = more points. Zero image assets needed.
- [ ] **💣 Minesweeper Duel** — one shared minesweeper board, teams alternate
  reveals; safe cells score, mines cost points and pass the turn; flags earn
  bonuses. Logic + blame.

## Smaller enhancement ideas

- Custom word lists per room (let the host paste in-jokes before starting Pictionary).
- Drawing replay animation during the Telephone reveal (strokes are already vector
  data in Pictionary — store strokes instead of PNGs and replay them).
- Persistent team leaderboard across game nights (one DB node, tiny page).
- Sound effects (correct guess ding, time-running-out tick).
