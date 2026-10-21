# 🎉 Office Games

Browser games for the monthly team social, built to survive corporate firewalls:
everything is a static site (hostable on GitHub Pages) that syncs through Firebase
Realtime Database — Google infrastructure, which company networks almost never block.

## Games

| Game | Status |
|------|--------|
| 🎨 [Pictionary](pictionary/) | Ready |
| 📞 [Drawing Telephone](telephone/) | Ready |
| 🧠 Quiz Night & more | See [IDEAS.md](IDEAS.md) |

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
