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

- [x] **🐑 Herd Mentality** — a prompt like "best biscuit?" or "most overrated
  film?"; everyone answers secretly; you score only if your answer matches the
  majority. No right answers, no content to author — the players are the content.
  The office argument generator.
- [x] **🕵️‍♂️ Spyfall** — everyone is dealt the same location (beach, space
  station, kitchen…) except one spy who gets nothing. Players interrogate each
  other out loud on the call; the spy bluffs; vote the spy out, spy wins by
  guessing the location. Needs only a location list.
- [x] **🔗 Connections** — NYT-style: 16 words hiding 4 groups of 4, teams race
  to find the groups with 4 strikes each. We author the puzzle packs (in-joke
  packs would be lethal).
- [x] **😏 Two Truths and a Lie** — the app collects 2 truths + 1 lie from each
  player in the lobby, then runs a round per player: everyone votes on the lie,
  points for fooling and detecting. Best new-joiner icebreaker.
- [x] **🔤 Letters Round** — Countdown-style: 9 random letters (pick vowel/
  consonant), longest valid word in 30s, dictionary-checked, team scores.
- [x] **🔢 Numbers Round** — Countdown maths: 6 numbers, a target, 60s; type an
  expression, the app validates it; closest team scores.
- [x] **🎲 Wits & Wagers** — a numeric question nobody knows exactly ("how long
  is the Great Wall of China?"); everyone estimates, estimates are lined up, then
  everyone bets on which is closest-without-going-over. Estimation + gambling.
- [x] **🏁 Typing Grand Prix** — same (original, non-copyrighted) paragraph for
  all; live progress bars per player; team relay scoring. Instant chaos.
- [x] **🚩 Flag Zoom** — an emoji flag rendered huge but heavily pixelated/
  blurred, sharpening over 20 seconds; first team to name the country scores —
  earlier = more points. Zero image assets needed.
- [x] **💣 Minesweeper Duel** — one shared minesweeper board, teams alternate
  reveals; safe cells score, mines cost points and pass the turn; flags earn
  bonuses. Logic + blame.

## Wave three — Claude's picks, 2026-10

- [x] **🧠 Memory Duel** — one shared grid of face-down emoji pairs; teams
  alternate flips, a match scores and keeps the turn. Everyone sees every flip,
  so paying attention during the other team's turn is the whole game.
- [x] **📈 Higher or Lower** — "Which country is bigger?", "Which came first?"
  Streak-based: keep answering comparisons to grow a streak, bank or bust.
  Stable facts only (areas, history dates), teams alternate.
- [x] **🏅 Masterpiece** — everyone draws the same prompt on their own canvas
  (reusing the Pictionary canvas), then an anonymous gallery vote picks the
  winner. Fibbage voting meets Pictionary drawing.
- [x] **⚡ Reaction Duel** — wait for the screen to flash green, click fast;
  false starts are penalized and broadcast for maximum shame. Reaction time is
  measured locally so network lag is fair. Team totals across rounds.
- [x] **🐍 Snake Pit** — everyone's snake in one arena at once, Frogger-style:
  food spawns deterministically from a shared seed, your collisions are local,
  other snakes are ghosts. Longest combined team length wins the round.
- [x] **🧮 Quick Maths** — rapid mental arithmetic chains ("17 + 8 × 2"), first
  correct answer takes the points, difficulty ramps. Sudden-death final.
- [x] **🪜 Word Ladder Race** — teams race CAT → DOG changing one letter at a
  time through valid words (reuses the Wordle dictionary). Fewest steps and
  fastest time both score.
- [x] **🔡 Scattergories** — one letter, 8 categories, 90 seconds; answers that
  duplicate another player's are cancelled; dubious answers get a group
  thumbs-vote. The voting arguments are the content.
- [x] **🎹 Simon League** — the classic growing color/sound sequence, everyone
  plays simultaneously on their own pad; last player standing earns their team
  the round. Tension builds beautifully on a call.
- [x] **🔤 Hangman Duel** — teams take turns guessing letters on the same hidden
  phrase; correct letters score, the letter that completes the phrase scores
  big, wrong guesses build the gallows against your team.

## Wave four — the drawing batch (Colin's brief: individual scores + leaderboards)

- [x] **🖼️ Who Drew It?** — everyone draws the same prompt; the anonymous gallery
  comes back and you match every drawing to its artist (+points per correct
  link), plus vote 🏆 best (+points to the artist) and 💩 worst (−points).
- [x] **✏️ Memory Sketch** — draw famous things from memory, no peeking: flags,
  currency symbols, country outlines, landmarks, the Bluetooth symbol. Peers
  vote most accurate and funniest; the real thing is shown for maximum pain.
- [x] **🧟‍♀️ Monster Factory** — exquisite corpse: you draw a head, someone else
  continues the torso from a 30px sliver, a third adds legs. Monsters assemble
  in a synchronized reveal, then everyone votes for the finest abomination.
- [x] **➰ One Line Wonder** — Pictionary, but the drawer gets exactly one
  continuous stroke: pen up, canvas locks. Guessers race in chat.
- [x] **🙈 Blind Canvas** — draw the prompt with invisible ink (you can't see
  your own drawing until you submit). One-at-a-time comedy reveal, then votes
  for most recognizable and funniest.

## Wave five — three more, 2026-10-22

- [x] **🌡️ Wavelength** — the psychic sees a hidden target on a spectrum
  ("a snack ↔ a meal") and gives one spoken clue; their team drags a shared
  dial to the guess. Points by closeness; the other team can steal a point by
  calling which side the guess missed on.
- [x] **🔐 The Vault** — the first co-op game: everyone vs a 20-minute clock,
  six sequential locks (cipher, logic, riddle, pattern, acrostic, combination).
  Wrong guesses cost 15s, hints cost 60s. Beat the vault together or lose
  together.
- [x] **🏃 Scavenger Dash** — "fetch something yellow — GO". Players physically
  run and race back (speed points), then show their haul on camera for a best-
  item vote. The game is real life; the app is the timer and scoreboard.
- [x] **🔮 Mind Readers** (Colin's idea) — two round types: a spotlight player
  secretly answers an either/or ("tea or coffee?") and everyone predicts their
  pick; and "who's more likely to…" where everyone votes a player and you score
  by matching the majority. Wholesome prompts only — know your colleagues, win.

## Wave six — requests from the team

- [x] **📍 Globetrotter** (teammate's request) — GeoGuessr-style: everyone sees
  the same mystery location and drops a pin on a world map; closest wins,
  points fall off with distance. Two modes: Street View walk-around (needs a
  Google Maps API key — one-time setup, free tier covers office use) or
  key-free progressive text clues. Guess map is OpenStreetMap/Leaflet.

## Wave seven — Jackbox-style (teammate request; original names & prompts)

- [x] **💬 Quip Duel** (Quiplash-style) — each prompt is answered by exactly two
  players; their answers face off and the room votes. Points by vote share,
  bonus for a shutout. Everyone answers two prompts per round.
- [x] **🖼️ Fakeout Gallery** (Drawful-style) — everyone draws a different absurd
  secret prompt; drawings shown one at a time while everyone else submits fake
  titles, then votes on the real one. Points for finding the truth, fooling
  people, and being guessable as the artist.

## Smaller enhancement ideas

- Custom word lists per room (let the host paste in-jokes before starting Pictionary).
- Drawing replay animation during the Telephone reveal (strokes are already vector
  data in Pictionary — store strokes instead of PNGs and replay them).
- Persistent team leaderboard across game nights (one DB node, tiny page).
- Sound effects (correct guess ding, time-running-out tick).
