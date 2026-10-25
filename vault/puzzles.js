// The Vault — puzzle sets. 3 vaults × 6 locks.
// Every puzzle is solvable from exactly what's on screen. Each lock carries a
// SOLUTION comment showing the full derivation; answers list every accepted
// form (they are normalized at runtime: lowercased, punctuation/spaces removed).

export const VAULTS = {
  A: {
    name: "The Bank Job",
    intro: "Midnight at the First National. Six locks stand between you and the vault.",
    locks: [
      {
        // SOLUTION: Caesar shift. "Turned three clicks forward" = each letter
        // was shifted +3, so shift back 3: Y→V, D→A, X→U, O→L, W→T = VAULT.
        type: "cipher",
        title: "The Dial Note",
        body: "A note is taped to the first dial:\n\n    Y D X O W\n\nBeneath it, in the locksmith's handwriting:\n\"Careless apprentice — he turned every letter three clicks forward along the alphabet. Turn them back.\"",
        answers: ["vault"],
        hints: [
          "Every letter was nudged the same number of steps along the alphabet. Undo it.",
          "Y stepped back three times is V. Do the same to the rest.",
        ],
      },
      {
        // SOLUTION: Fibonacci. 8 + 13 = 21.
        type: "sequence",
        title: "The Worn Keypad",
        body: "The keypad's used keys spell out a sequence, with one key polished blank:\n\n    1   1   2   3   5   8   13   ?",
        answers: ["21", "twenty one", "twentyone"],
        hints: [
          "Each number is built from the two numbers before it.",
          "8 + 13 = the answer.",
        ],
      },
      {
        // SOLUTION: Brass is neither Ana's nor Ben's → Cleo has brass.
        // Ben refuses silver → Ben has iron. Ana gets silver. Iron = BEN.
        type: "logic",
        title: "Three Tellers",
        body: "Three tellers each carry one key: brass, silver, iron.\n\n• The brass key is held by neither Ana nor Ben.\n• Ben refuses to touch silver.\n\nThe iron key opens this lock. WHO holds it?",
        answers: ["ben"],
        hints: [
          "Start with the brass key — only one teller can possibly hold it.",
          "If Cleo holds brass and Ben won't hold silver, Ben is left with exactly one key.",
        ],
      },
      {
        // SOLUTION: riddle — a BOOK has a spine, tells stories.
        type: "riddle",
        title: "The Manager's Riddle",
        body: "Engraved on the fourth lock:\n\n\"I have a spine but no bones.\nI tell stories but never speak.\nOpen me and I still won't run.\"",
        answers: ["book", "a book"],
        hints: [
          "It sits on a shelf in the manager's office.",
          "Spine, cover, pages…",
        ],
      },
      {
        // SOLUTION: acrostic — Oranges Pears Eggs Nutmeg → O P E N.
        type: "acrostic",
        title: "The Shopping List",
        body: "Pinned to the staff board, the manager's shopping list:\n\n    Oranges\n    Pears\n    Eggs\n    Nutmeg\n\nThe guard mutters: \"He always said the list itself is the password.\"",
        answers: ["open"],
        hints: [
          "Read only the beginnings.",
          "Take the first letter of each item, top to bottom.",
        ],
      },
      {
        // SOLUTION: d1 = 9 − 4 = 5; d2 = 2×5 − 7 = 3; d3 = 5 + 3 = 8 → 538.
        type: "combination",
        title: "The Final Dial",
        body: "Three brass plaques circle the last dial. It takes a 3-digit code.\n\n• First digit: nine minus four.\n• Second digit: double the first digit, then subtract seven.\n• Third digit: the first digit plus the second digit.",
        answers: ["538"],
        hints: [
          "Work left to right — each digit builds on the one before it.",
          "The first digit is 5. Keep going.",
        ],
      },
    ],
  },

  B: {
    name: "The Museum Heist",
    intro: "The night guard is asleep. Six locks protect the restricted wing.",
    locks: [
      {
        // SOLUTION: riddle — FOOTSTEPS (footprints also accepted).
        type: "riddle",
        title: "The Marble Floor",
        body: "Etched into the entrance hall floor:\n\n\"The more of me you take,\nthe more of me you leave behind.\nWhat am I?\"",
        answers: ["footsteps", "footstep", "footprints", "footprint", "steps"],
        hints: [
          "Think about crossing this marble floor.",
          "Look down behind you.",
        ],
      },
      {
        // SOLUTION: every letter slipped one step ahead → shift back 1:
        // T→S, U→T, P→O, O→N, F→E = STONE.
        type: "cipher",
        title: "The Painted Frame",
        body: "Painted along an empty picture frame:\n\n    T U P O F\n\nA label beneath it reads: \"Restoration note — every letter has slipped one step ahead of itself.\"",
        answers: ["stone"],
        hints: [
          "Slide each letter back a single step in the alphabet.",
          "T becomes S. Continue.",
        ],
      },
      {
        // SOLUTION: prime numbers; next prime after 13 is 17.
        type: "sequence",
        title: "The Display Case",
        body: "The case's combination wheel shows:\n\n    2   3   5   7   11   13   ?",
        answers: ["17", "seventeen"],
        hints: [
          "None of these numbers can be divided evenly by anything except 1 and themselves.",
          "Count up from 13 and test each number against that rule.",
        ],
      },
      {
        // SOLUTION: jade immediately right of marble → (M1,J2) or (M2,J3).
        // Bronze not on 3. If M1,J2 then bronze must take 3 — forbidden.
        // So M2, J3, B1. Jade is on pedestal 3.
        type: "logic",
        title: "Three Statues",
        body: "Three statues — marble, bronze, jade — stand on pedestals 1, 2, 3 (left to right).\n\n• The jade statue is immediately to the right of the marble one.\n• The bronze statue is not on pedestal 3.\n\nWHICH PEDESTAL (1, 2 or 3) holds the jade statue?",
        answers: ["3", "three", "pedestal 3", "pedestal three"],
        hints: [
          "Try marble on pedestal 1 — where must jade go, and what is left for bronze?",
          "That arrangement breaks the bronze rule, so marble must be on pedestal 2.",
        ],
      },
      {
        // SOLUTION: acrostic — Lanterns Ivory Globes Hourglasses Telescopes → LIGHT.
        type: "acrostic",
        title: "The Curator's Favourites",
        body: "The curator's handwritten list of favourite exhibits, in order:\n\n    Lanterns\n    Ivory\n    Globes\n    Hourglasses\n    Telescopes\n\nHer diary notes: \"my password hides in plain sight.\"",
        answers: ["light"],
        hints: [
          "Plain sight means first sight.",
          "Initial letters, top to bottom.",
        ],
      },
      {
        // SOLUTION: quarter of an hour = 15; two fortnights = 28 days → 1528.
        type: "combination",
        title: "The Alarm Panel",
        body: "The alarm takes a 4-digit code. The installer's card reads:\n\n• The first two digits: the number of minutes in a quarter of an hour.\n• The last two digits: the number of days in two fortnights.",
        answers: ["1528"],
        hints: [
          "A quarter of an hour, then two fortnights, side by side.",
          "15, then 28.",
        ],
      },
    ],
  },

  C: {
    name: "The Midnight Train",
    intro: "The treasury car is six locks deep. The train reaches the border at dawn.",
    locks: [
      {
        // SOLUTION: halving. 8 ÷ 2 = 4.
        type: "sequence",
        title: "The Luggage Tag",
        body: "Stamped along a battered luggage tag:\n\n    64   32   16   8   ?",
        answers: ["4", "four"],
        hints: [
          "Every number receives the same treatment.",
          "Halve it.",
        ],
      },
      {
        // SOLUTION: Eli exactly one carriage behind Fox → (Fox A, Eli B) or
        // (Fox B, Eli C). Second option forces Dot into A — forbidden.
        // So Fox A, Eli B, Dot C. Carriage C = DOT.
        type: "logic",
        title: "Three Passengers",
        body: "Three passengers — Dot, Eli, Fox — sit in carriages A, B, C (A is the front).\n\n• Dot is not in carriage A.\n• Eli is exactly one carriage behind Fox.\n\nThe conductor says the key is with WHOEVER sits in carriage C.",
        answers: ["dot"],
        hints: [
          "Place Fox first — only two seats make the Eli clue possible.",
          "If Fox sat in B, Dot would be forced into carriage A. So Fox sits at the front.",
        ],
      },
      {
        // SOLUTION: riddle — a RIVER has a bed and a mouth.
        type: "riddle",
        title: "The Bridge Crossing",
        body: "Scratched into the window as the train rumbles over a bridge:\n\n\"I have a bed but never sleep.\nI have a mouth but never eat.\nI run but never walk.\"",
        answers: ["river", "a river"],
        hints: [
          "It flows.",
          "The train is crossing one right now.",
        ],
      },
      {
        // SOLUTION: five-fingered handprint = shift 5. Shift back 5:
        // Y→T, W→R, F→A, H→C, P→K = TRACK.
        type: "cipher",
        title: "The Chalked Wall",
        body: "Chalked on the carriage wall:\n\n    Y W F H P\n\nBeneath it, a five-fingered handprint shoving the letters forward down the alphabet.",
        answers: ["track"],
        hints: [
          "Five fingers — the letters were pushed five steps forward. Push them back.",
          "Y stepped back five times is T.",
        ],
      },
      {
        // SOLUTION: acrostic — Signals Tickets Engine Axles Mirrors → STEAM.
        type: "acrostic",
        title: "The Conductor's Checklist",
        body: "The conductor's pre-departure checklist, clipped by the door:\n\n    Signals\n    Tickets\n    Engine\n    Axles\n    Mirrors\n\n\"Everything a driver needs,\" he winks, \"is at the start.\"",
        answers: ["steam"],
        hints: [
          "Check the checklist's edges.",
          "First letters, top to bottom.",
        ],
      },
      {
        // SOLUTION: tripod = 3 legs; pentagon = 5 sides; 3 + 5 = 8 → 358.
        type: "combination",
        title: "The Driver's Padlock",
        body: "The driver's padlock takes a 3-digit code. His notebook says:\n\n• First digit: the legs on a tripod.\n• Second digit: the sides of a pentagon.\n• Third digit: the first two digits added together.",
        answers: ["358"],
        hints: [
          "Tripod, pentagon, then the sum.",
          "3, 5, then add them.",
        ],
      },
    ],
  },
};
