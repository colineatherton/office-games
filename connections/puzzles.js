// Handcrafted Connections puzzles. Each puzzle: 4 groups of 4, ordered
// easy (yellow) → hard (purple). Within a puzzle every word appears in exactly
// one group — red herrings are deliberate (CRUISE looks like ___ SHIP but
// belongs to Famous Toms), but the answer key is always unique.
// Add your own — in-joke puzzles are the best puzzles.

export const PUZZLES = [
  {
    groups: [
      { title: "Breakfast foods", words: ["TOAST", "CEREAL", "PANCAKE", "OMELETTE"] },
      { title: "Classroom pets", words: ["HAMSTER", "GOLDFISH", "PARROT", "RABBIT"] },
      { title: "Weather", words: ["DRIZZLE", "FROST", "THUNDER", "BREEZE"] },
      { title: "___ BOARD", words: ["KEY", "SURF", "CUP", "DART"] },
    ],
  },
  {
    groups: [
      { title: "Shades of blue", words: ["NAVY", "TEAL", "SKY", "ROYAL"] },
      { title: "Card games", words: ["POKER", "BRIDGE", "SOLITAIRE", "RUMMY"] },
      { title: "Things with keys", words: ["PIANO", "LAPTOP", "LOCK", "FLORIDA"] },
      { title: "___ FIRE", words: ["CAMP", "BON", "CROSS", "CEASE"] },
    ],
  },
  {
    groups: [
      { title: "Pizza toppings", words: ["MUSHROOM", "PEPPERONI", "OLIVE", "HAM"] },
      { title: "Famous Toms", words: ["HANKS", "CRUISE", "HOLLAND", "HARDY"] },
      { title: "___ SHIP", words: ["FRIEND", "RELATION", "CHAMPION", "OWNER"] },
      { title: "___ + LET = a word", words: ["OUT", "BOOK", "TAB", "PIG"] },
    ],
  },
  {
    groups: [
      { title: "Meeting words", words: ["AGENDA", "MINUTES", "ACTION", "RECAP"] },
      { title: "Email things", words: ["INBOX", "DRAFT", "SPAM", "ARCHIVE"] },
      { title: "Desk supplies", words: ["STAPLER", "MARKER", "NOTEPAD", "PAPERCLIP"] },
      { title: "___ CALL", words: ["ROLL", "COLD", "CLOSE", "CURTAIN"] },
    ],
  },
  {
    groups: [
      { title: "Racket sports", words: ["TENNIS", "BADMINTON", "SQUASH", "PADEL"] },
      { title: "Vegetables", words: ["CARROT", "SPINACH", "BROCCOLI", "LEEK"] },
      { title: "Dances", words: ["SALSA", "TANGO", "WALTZ", "SWING"] },
      { title: "Playground equipment", words: ["SLIDE", "SEESAW", "ROUNDABOUT", "SANDPIT"] },
    ],
  },
  {
    groups: [
      { title: "Capital cities", words: ["PARIS", "LIMA", "OSLO", "CAIRO"] },
      { title: "Beans", words: ["PINTO", "SOYA", "BAKED", "RUNNER"] },
      { title: "Organs", words: ["LIVER", "HEART", "LUNG", "SPLEEN"] },
      { title: "BLACK ___", words: ["SMITH", "BERRY", "BIRD", "OUT"] },
    ],
  },
  {
    groups: [
      { title: "Currencies", words: ["POUND", "YEN", "EURO", "PESO"] },
      { title: "Units of weight", words: ["GRAM", "TONNE", "OUNCE", "STONE"] },
      { title: "Big cats", words: ["JAGUAR", "PUMA", "LEOPARD", "LYNX"] },
      { title: "___ MARKET", words: ["STOCK", "FLEA", "SUPER", "BLACK"] },
    ],
  },
  {
    groups: [
      { title: "Parts of a book", words: ["CHAPTER", "INDEX", "SPINE", "COVER"] },
      { title: "Parts of the body", words: ["SHIN", "PALM", "TEMPLE", "CALF"] },
      { title: "Trees", words: ["OAK", "WILLOW", "MAPLE", "BIRCH"] },
      { title: "___ POT", words: ["TEA", "JACK", "FLOWER", "HOT"] },
    ],
  },
  {
    groups: [
      { title: "Nordic countries", words: ["NORWAY", "FINLAND", "ICELAND", "DENMARK"] },
      { title: "Hidden numbers", words: ["CANINE", "FREIGHT", "OFTEN", "WONDER"] },
      { title: "Chess pieces", words: ["KING", "QUEEN", "BISHOP", "ROOK"] },
      { title: "One-word bands", words: ["ABBA", "OASIS", "BLONDIE", "GENESIS"] },
    ],
  },
  {
    groups: [
      { title: "Pasta shapes", words: ["PENNE", "FUSILLI", "MACARONI", "LASAGNE"] },
      { title: "Hats", words: ["BERET", "FEDORA", "PANAMA", "BOWLER"] },
      { title: "Cricket terms", words: ["WICKET", "CREASE", "OVER", "DUCK"] },
      { title: "___ COAT", words: ["RAIN", "TRENCH", "WAIST", "TOP"] },
    ],
  },
  {
    groups: [
      { title: "Gemstones", words: ["RUBY", "OPAL", "JADE", "PEARL"] },
      { title: "Programming languages", words: ["PYTHON", "JAVA", "RUST", "SWIFT"] },
      { title: "Snakes", words: ["COBRA", "VIPER", "MAMBA", "ADDER"] },
      { title: "Meaning 'fast'", words: ["RAPID", "BRISK", "NIPPY", "SPEEDY"] },
    ],
  },
  {
    groups: [
      { title: "Breads", words: ["BAGUETTE", "SOURDOUGH", "PITA", "RYE"] },
      { title: "Board games", words: ["CHESS", "SCRABBLE", "MONOPOLY", "CLUEDO"] },
      { title: "Drinks", words: ["ESPRESSO", "MOJITO", "CIDER", "COCOA"] },
      { title: "Hidden 'EAR'", words: ["BEARD", "HEARTH", "LEARN", "SEARCH"] },
    ],
  },
  {
    groups: [
      { title: "Olympic sports", words: ["ROWING", "FENCING", "DIVING", "ARCHERY"] },
      { title: "Things with blades", words: ["RAZOR", "SKATE", "WINDMILL", "PROPELLER"] },
      { title: "___ JUMP", words: ["BUNGEE", "LONG", "HIGH", "TRIPLE"] },
      { title: "At the bank", words: ["VAULT", "TELLER", "BRANCH", "SAFE"] },
    ],
  },
  {
    groups: [
      { title: "Citrus fruits", words: ["LEMON", "LIME", "ORANGE", "GRAPEFRUIT"] },
      { title: "Colors", words: ["CRIMSON", "INDIGO", "VIOLET", "AMBER"] },
      { title: "Tropical storms", words: ["CYCLONE", "TYPHOON", "TORNADO", "MONSOON"] },
      { title: "NATO alphabet", words: ["VICTOR", "HOTEL", "GOLF", "ROMEO"] },
    ],
  },
  {
    groups: [
      { title: "Kitchen utensils", words: ["WHISK", "LADLE", "SPATULA", "TONGS"] },
      { title: "Greek letters", words: ["DELTA", "OMEGA", "SIGMA", "THETA"] },
      { title: "___ FORCE", words: ["AIR", "TASK", "WORK", "BRUTE"] },
      { title: "Types of test", words: ["ORAL", "MOCK", "DRIVING", "BLOOD"] },
    ],
  },
  {
    groups: [
      { title: "Poker terms", words: ["FLUSH", "RIVER", "FOLD", "BLUFF"] },
      { title: "Laundry verbs", words: ["WASH", "RINSE", "SPIN", "PRESS"] },
      { title: "Gym exercises", words: ["PLANK", "SQUAT", "LUNGE", "CRUNCH"] },
      { title: "Pirate things", words: ["PARROT", "PATCH", "HOOK", "DOUBLOON"] },
    ],
  },
];
