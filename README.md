# 🎉 Office Games

Browser games for the monthly team social, built to survive corporate firewalls:
everything is a static site (hostable on GitHub Pages) that syncs through Firebase
Realtime Database — Google infrastructure, which company networks almost never block.

## Games

| Game | Players | Format |
|------|---------|--------|
| 🎨 [Pictionary](pictionary/) | 2+ | Red vs Blue, draw & guess |
| 📞 [Drawing Telephone](telephone/) | 2+ (4+ is best) | Write → draw → describe chains |
| 🧠 [Quiz Buzzer](quiz/) | 3+ (host + 2) | Teams race to buzz, host adjudicates |
| 🕵️ [Codenames](codenames/) | 4+ | Spymasters give spoken clues |
| 🤥 [Fibbage](fibbage/) | 3+ (5+ is best) | Fool each other with fake answers |
| 🎬 [Emoji Guesser](emoji/) | 2+ | Pictionary with an emoji palette |
| 🟩 [Wordle Race](wordle/) | 2+ | Both teams race on the same word |
| 🌍 [Polyglot](polyglot/) | 2+ | Match words across languages |
| 🐸 [Frogger Rush](frogger/) | 2+ | Everyone hops at once, live arcade |
| 🎤 [Finish the Line](lyrics/) | 2+ | Fill the missing word in famous song titles |
| 🐑 [Herd Mentality](herd/) | 3+ | Match the majority answer, solo scores |
| 🕵️‍♂️ [Spyfall](spyfall/) | 3+ | Find the spy by interrogation, solo scores |
| 🔗 [Connections](connections/) | 2+ | Teams race the same 16-word puzzle |
| 😏 [Two Truths and a Lie](twotruths/) | 3+ | Icebreaker voting, solo scores |
| 🔤 [Letters Round](letters/) | 2+ | Countdown letters, best word per team |
| 🔢 [Numbers Round](numbers/) | 2+ | Countdown maths with a real expression checker |
| 🎲 [Wits & Wagers](wagers/) | 3+ | Estimate, then bet on the best estimate |
| 🏁 [Typing Grand Prix](typing/) | 2+ | Live typing race lanes |
| 🚩 [Flag Zoom](flagzoom/) | 2+ | Guess the sharpening flag (canvas-drawn, Windows-safe) |
| 💣 [Minesweeper Duel](minesweeper/) | 2+ | Shared minefield, push-your-luck turns |
| 🧠 [Memory Duel](memory/) | 2+ | Shared pairs board, teams alternate |
| 📈 [Higher or Lower](higherlower/) | 2+ | Fact comparisons, streak and bank |
| 🏅 [Masterpiece](masterpiece/) | 3+ | Draw the prompt, anonymous gallery vote |
| ⚡ [Reaction Duel](reaction/) | 2+ | Reflex clicks, lag-proof local timing |
| 🐍 [Snake Pit](snakepit/) | 2+ | Everyone's snake in one arena |
| 🧮 [Quick Maths](quickmaths/) | 2+ | First correct answer wins, ramps up |
| 🪜 [Word Ladder Race](wordladder/) | 2+ | COLD→WARM one letter at a time |
| 🔡 [Scattergories](scattergories/) | 3+ | One letter, 8 categories, duplicates cancel |
| 🎹 [Simon League](simon/) | 2+ | Simultaneous Simon, deepest sequence wins |
| 🔤 [Hangman Duel](hangman/) | 2+ | Same phrase, each team has its own gallows |
| ➰ [One Line Wonder](oneline/) | 2+ | Pictionary with exactly one stroke, solo scores |
| 🖼️ [Who Drew It?](whodrewit/) | 3+ | Match drawings to artists, vote best & worst |
| ✏️ [Memory Sketch](memorysketch/) | 3+ | Draw flags & symbols from memory, peers judge |
| 🧟‍♀️ [Monster Factory](monsterfactory/) | 3+ | Exquisite-corpse monsters, synchronized reveal |
| 🙈 [Blind Canvas](blindcanvas/) | 3+ | Invisible-ink drawing, comedy reveal |

More ideas in [IDEAS.md](IDEAS.md). Each game page explains its own rules;
quick summaries below.

---

## One-time setup (≈5 minutes, free, no credit card)

The games need a Firebase project to sync players. One person does this once for
the whole team:

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign
   in with any Google account → **Create a project** (call it anything, e.g.
   `office-games`). You can disable Google Analytics when asked.
2. In the left sidebar: **Build → Realtime Database → Create database**.
   Pick the region closest to you and start in **test mode**.
   (Test mode rules expire after 30 days — see "Database rules" below for
   permanent ones.)
3. Click the ⚙️ gear → **Project settings**. Under *Your apps*, click the web
   icon **`</>`**, register an app (no hosting needed).
4. It shows you a `firebaseConfig` object. Copy it into
   [`firebase-config.js`](firebase-config.js) at the repo root (shared by all
   games), replacing the placeholder.
   - Make sure the config includes `databaseURL`. If it doesn't, copy the URL
     shown at the top of the Realtime Database page (looks like
     `https://office-games-default-rtdb.europe-west1.firebasedatabase.app`) and
     add it as `databaseURL: "..."`.

### Database rules (recommended)

Test mode locks everyone out after 30 days. In **Realtime Database → Rules**,
paste this instead — it's open (fine for a casual game, there's nothing sensitive)
but scoped to the game's data:

```json
{
  "rules": {
    "rooms": {
      "$room": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

The free (Spark) plan limits are 100 simultaneous connections and 1 GB storage —
way more than a social hour needs. If old rooms pile up, just delete the `rooms`
node in the Firebase console now and then.

## Run it locally (to test)

Browsers block ES modules from `file://` URLs, so serve the folder:

```bash
cd office-games
python3 -m http.server 8080
# open http://localhost:8080/pictionary/
```

Open two browser windows (one normal, one incognito so you get two player
identities) to test multiplayer on your own.

## Deploy to GitHub Pages

1. Create a GitHub repo and push this folder's contents.
2. Repo **Settings → Pages → Source: Deploy from a branch** → `main`, root folder.
3. The site appears at `https://<username>.github.io/<repo>/pictionary/`.

Share the room link from the lobby ("Copy invite link") in the video call chat —
it includes the room code.

> Note: the Firebase config in the repo is public. That's normal and fine — these
> keys only identify the project, they're not secrets. Anyone with the URL could
> write to the database, but for an office game that risk is "a coworker trolls
> you", which honestly might improve the game.

---

## 🎨 Pictionary — how to play

- One person creates a room and shares the invite link; everyone else joins.
  No player limit. Players are auto-balanced into **Red** and **Blue** teams
  (switch teams by clicking in the lobby).
- The host picks drawing time + number of turns and starts the game.
- Drawers rotate, alternating between teams. The drawer picks one of three words
  (easy / medium / hard) and draws it.
- **Everyone else guesses** by typing in the chat. A correct guess earns
  **20 points + 1 per second remaining** for the guesser's *team* — so both teams
  race to guess every drawing, whoever drew it.
- Once you've guessed correctly (or if you're the drawer), your chat messages are
  hidden from players still guessing, so you can gloat safely.
- The turn ends when everyone has guessed or time runs out. Highest team score
  after the final turn wins.

**House rule:** no letters, numbers, or writing words on the canvas. We can't
stop you. Your team can judge you.

*(Fine print: the game state, including the current word, lives in a shared
database that anyone can inspect with dev tools. It's an honor-system game —
cheaters answer to HR.)*

---

## 📞 Drawing Telephone — how to play

Like the kids' game Telephone, but alternating between drawings and descriptions
(a Gartic Phone clone).

- Everyone joins a room and the host starts the game. Works with 2 players,
  gets properly funny from 4+. Mid-game joiners spectate and get dealt in next round.
- **Step 1:** everyone writes a weird sentence ("a giraffe stuck in a revolving door").
- **Step 2:** everyone receives *someone else's* sentence and has to **draw** it.
- **Step 3:** everyone receives *someone else's* drawing (only the drawing!) and
  has to **describe** it in words.
- Steps keep alternating draw/describe until each chain has passed through
  (up to) every player. Run out of time and the game auto-submits whatever you
  have — or a suitably embarrassing placeholder.
- **The reveal:** the host walks everyone through each chain one step at a time,
  synchronized on all screens, so the whole call watches "a giraffe in a
  revolving door" become "angry ostrich in a washing machine" together.

No points, no teams — the reveal is the prize.

---

## The rest, in brief

**🧠 Quiz Buzzer** — the room creator is the quizmaster (they see the answers;
nobody else does). Each question gets a 3-2-1 countdown, then first to hit the
big BUZZ button (or spacebar) answers *out loud* on the call. Quizmaster clicks
✅ (+10) or ❌ (−5, buzzing reopens, that player is locked out for the question).
Ships with 72 starter questions — edit `quiz/questions.js` to add your own.

**🕵️ Codenames** — 5×5 word grid; each team claims a spymaster who can see which
words are theirs. Clues are given out loud ("fruit, two!"), teammates click to
reveal. Hit a neutral or enemy word and your turn ends; hit the assassin and you
lose instantly. No timer — arguing is the game.

**🤥 Fibbage** — individual scores, needs 3+. Everyone sees a weird-but-true
fact with a blank, writes a convincing fake answer, then votes on which of the
shuffled answers is the truth. +100 for finding the truth, +50 for each person
your lie fools. 49 verified questions in `fibbage/questions.js`.

**🎬 Emoji Guesser** — Pictionary's rules, but the "drawer" composes a clue from
an emoji palette instead of drawing. Prompts are famous movies, songs, and
sayings; guessers race in chat; 20 + seconds-remaining points to the guesser's
team.

**🟩 Wordle Race** — both teams race to solve the *same* hidden 5-letter word,
6 guesses per team. You can see the opponent's tile colors but not their
letters. Teammates alternate guesses. Best of 3/5/7.

**🌍 Polyglot** — a board of 24 foreign words (language shown, meaning hidden)
that group into 6 hidden meanings. Click two words that mean the same thing to
claim them for your team; wrong pairs lock your whole team out for 4 seconds.
Beware cognate bait — *chat* is French for cat.

**🐸 Frogger Rush** — everyone plays at once. Hop your frog across the road and
river (arrows/WASD/touch); each crossing is +10 for your team; deaths are free
but humiliating (they're counted). Traffic is deterministic from a shared seed,
so lag can't kill you — only your own reflexes can.

**🎤 Finish the Line** — a famous song title with a word missing ("Livin' on a
___" · Bon Jovi); everyone types the answer against the clock, correct answers
score for your team. The built-in pack is song *titles* only (lyric lines are
copyrighted, and this repo is public) — but the host can type their own custom
fill-in-the-blank questions in the lobby for anything-goes rounds.

**🐑 Herd Mentality** — everyone secretly answers the same prompt ("best
biscuit?"); anyone in the biggest matching group scores. The loneliest unique
answer holds the 🐄 Pink Cow of shame. Individual scores, first to 8.

**🕵️‍♂️ Spyfall** — everyone is dealt the same location except the spy.
Interrogate each other out loud; call votes, or if you're the spy, guess the
location before they catch you. Individual scores.

**🔗 Connections** — both teams race the same NYT-style puzzle: 16 words, 4
hidden groups, 4 strikes each. "One away!" taunts included. You see the other
team's group count, never their board.

**😏 Two Truths and a Lie** — everyone locks in two truths and a lie in the
lobby; each round the group votes on one player's lie. Points for detecting,
points for deceiving, 🏆 Best Liar crowned at the end.

**🔤 Letters Round & 🔢 Numbers Round** — Countdown, basically. Letters: 9
tiles, best word per team scores its length. Numbers: six numbers, a target,
and a validator that enforces the classic rules (exact division only, no
negative intermediates). Both one-shot submissions.

**🎲 Wits & Wagers** — a numeric question nobody knows ("how long is the Great
Wall?"); everyone estimates, then everyone bets on the estimate they trust.
Closest without going over wins. Individual scores.

**🏁 Typing Grand Prix** — the same (original, llama-heavy) paragraph for all;
typos block you until fixed; live race lanes with little cars. Team relay
scoring plus a 🏎️ fastest-WPM crown.

**🚩 Flag Zoom** — a heavily pixelated flag sharpens over 25 seconds; first
correct guess in chat scores more the earlier it lands. Flags are drawn on
canvas (not emoji) so they render identically on every OS — and yes, guessing
"Chad" on Romania counts.

**💣 Minesweeper Duel** — one shared minefield, teams alternate push-your-luck
turns: every safe cell +1, keep clicking or pass; a mine is −10 and ends your
turn. First click always cascades.

**🧠 Memory Duel** — classic Concentration on one shared board; a match keeps
your team's turn, and every flip is visible to everyone — the other team's
misses are your map.

**📈 Higher or Lower** — "Which is larger by area?", "Which happened first?"
Answer comparisons to build a streak, then bank it or push on and risk it all.
Stable facts only, generated with wide margins so answers are never ambiguous.

**🏅 Masterpiece** — everyone draws the same prompt; the anonymous gilt-frame
gallery votes a winner. Individual scores, +10 per vote.

**⚡ Reaction Duel** — wait for green, click fast. Reaction time is measured on
your own machine so lag can't help or hurt; false starts are broadcast with
your name on them. Watch for the yellow fake-outs.

**🐍 Snake Pit** — everyone's snake in one arena at once, racing to the same
apple. Your crashes are your own fault (collisions are local); other snakes are
ghosts. Eat to grow, grow for glory, die for laughs.

**🧮 Quick Maths** — mental arithmetic, first correct answer takes the points.
Wrong answers lock you out for 3 seconds. Ties end in sudden death.

**🪜 Word Ladder Race** — both teams climb from the same start word to the same
target, changing one letter per rung. Beat par for a bonus; every puzzle is
verified solvable.

**🔡 Scattergories** — a letter and 8 categories; answers duplicated by anyone
else are cancelled, dubious ones face a group challenge vote. Individual scores.

**🎹 Simon League** — the growing sequence, everyone playing their own pad at
once, with live level bars. Knock-outs watch the survivors sweat.

**🔤 Hangman Duel** — teams alternate letters on the same phrase; correct
letters score and keep your turn, wrong ones build your team's own gallows.
Six wrongs and you're spectating.

**➰ One Line Wonder** — Pictionary with exactly one continuous stroke: the
moment the pen lifts, the canvas locks forever. Individual scores, ✒️ Smoothest
Operator crowned.

**🖼️ Who Drew It?** — everyone draws the same prompt; the anonymous gallery
returns and you match every drawing to its artist (+5 per correct link), then
crown a 🏆 best (+10 to the artist) and a 💩 worst (−5). A boobie prize awaits
the most consistently worst artist.

**✏️ Memory Sketch** — draw the flag of Japan, the euro symbol, or the
Bluetooth logo *from memory*, no peeking. The gallery votes most accurate and
funniest — next to a rendering of the real thing, for maximum pain.

**🧟‍♀️ Monster Factory** — the fold-over paper game: you draw a head, the next
person continues a torso from a 30-pixel sliver, a third adds legs. Monsters
assemble part by part in a synchronized reveal; votes reward all three
contributors of the finest abomination.

**🙈 Blind Canvas** — draw the prompt with invisible ink: your strokes are
recorded but you can't see them until the one-at-a-time public reveal (artist
credit lands three seconds after the laughter). Votes for most recognizable
and funniest.
