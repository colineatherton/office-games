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
