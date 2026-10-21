// Prompts for Emoji Guesser. Everything here should be VERY well known —
// the fun is the emoji translation, not obscurity. Add your own favourites.

export const MOVIES = [
  "The Lion King", "Titanic", "Jaws", "Finding Nemo", "Jurassic Park",
  "Star Wars", "Harry Potter", "The Wizard of Oz", "Snow White", "Cinderella",
  "Frozen", "Up", "Toy Story", "Shrek", "Batman",
  "Spider-Man", "Superman", "Back to the Future", "Home Alone", "Rocky",
  "King Kong", "Godzilla", "Forrest Gump", "Cast Away", "The Terminator",
  "Avatar", "Ratatouille", "Kung Fu Panda", "Madagascar", "Ice Age",
  "Pirates of the Caribbean", "The Hunger Games", "Ghostbusters", "Men in Black", "Gladiator",
  "Charlie and the Chocolate Factory", "Alice in Wonderland", "Peter Pan", "Aladdin", "Beauty and the Beast",
  "The Little Mermaid", "Moana", "Monsters Inc", "Cars", "Despicable Me",
  "Minions", "The Lego Movie", "Jumanji", "The Karate Kid", "101 Dalmatians",
  "The Jungle Book", "Mulan", "The Incredibles", "Inside Out", "Coco",
  "Groundhog Day", "Mean Girls", "Grease", "Mamma Mia", "Top Gun",
  "Mary Poppins", "The Sound of Music", "Snakes on a Plane", "Independence Day", "Twister",
];

export const SONGS = [
  "Bohemian Rhapsody", "Imagine", "Hey Jude", "Let It Be", "Yellow Submarine",
  "Hotel California", "Stairway to Heaven", "Billie Jean", "Thriller", "Beat It",
  "Dancing Queen", "Mamma Mia", "Waterloo", "I Will Survive", "Stayin' Alive",
  "YMCA", "Macarena", "Gangnam Style", "Baby Shark", "Shape of You",
  "Rolling in the Deep", "Hello", "Umbrella", "Single Ladies", "Firework",
  "Roar", "Shake It Off", "Uptown Funk", "Happy", "Old Town Road",
  "Blinding Lights", "Watermelon Sugar", "Bad Guy", "Counting Stars", "Radioactive",
  "Thunder", "Eye of the Tiger", "We Will Rock You", "We Are the Champions", "Don't Stop Believin'",
  "Livin' on a Prayer", "Sweet Caroline", "Wonderwall", "Let It Go", "Under the Sea",
  "Hakuna Matata", "Purple Rain", "Ring of Fire", "Take On Me", "Africa",
  "Never Gonna Give You Up", "Walking on Sunshine", "Here Comes the Sun", "Man in the Mirror", "Sweet Dreams",
];

export const THINGS = [
  "spill the beans", "couch potato", "brainstorm", "piece of cake", "break a leg",
  "hit the hay", "under the weather", "cold feet", "butterflies in your stomach", "raining cats and dogs",
  "the elephant in the room", "let the cat out of the bag", "kill two birds with one stone", "a fish out of water", "the early bird catches the worm",
  "when pigs fly", "hold your horses", "a wolf in sheep's clothing", "curiosity killed the cat", "busy as a bee",
  "night owl", "bookworm", "social butterfly", "home sweet home", "love is blind",
  "time is money", "money talks", "back to square one", "barking up the wrong tree", "beat around the bush",
  "bite the bullet", "blessing in disguise", "burn the midnight oil", "cat nap", "cry wolf",
  "don't judge a book by its cover", "every cloud has a silver lining", "go the extra mile", "heart of gold", "icing on the cake",
  "it takes two to tango", "needle in a haystack", "on thin ice", "once in a blue moon", "see eye to eye",
  "smell a rat", "speak of the devil", "tie the knot", "walk on eggshells", "a storm in a teacup",
];

// The builder's picker grid, loosely grouped: faces, people & actions, animals,
// food & drink, objects, travel & places, nature, symbols & misc.
export const EMOJI_PALETTE = [
  "😀", "😂", "😍", "😭", "😱", "😡", "🥶", "🥵", "😴", "🤔", "🤫", "🤯", "😇", "😈", "🤡", "💀",
  "👶", "👩", "👨", "👵", "👑", "🕵️", "🧙", "🧛", "🦸", "🏃", "💃", "🕺", "🙏", "💪", "🤝", "👀",
  "👍", "👎", "👉", "👈", "👆", "👇", "✋", "👂", "👃", "👄", "🦶", "🫀", "🧠", "🗣️", "👣", "🤳",
  "🐶", "🐱", "🦁", "🐯", "🐴", "🐮", "🐷", "🐭", "🐰", "🦊", "🐻", "🐼", "🐸", "🐵", "🐔", "🐧",
  "🦅", "🦉", "🐍", "🐢", "🐠", "🐬", "🐳", "🦈", "🐙", "🦀", "🐝", "🦋", "🕷️", "🦖", "🐘", "🦒",
  "🍎", "🍌", "🍇", "🍉", "🍋", "🍒", "🥥", "🍞", "🧀", "🍔", "🍟", "🍕", "🌮", "🍝", "🍣", "🍦",
  "🍩", "🍰", "🎂", "🍫", "🍿", "☕", "🍺", "🍷", "🥛", "🥚", "🥔", "🌽", "🥕", "🍑", "🫘", "🧊",
  "📱", "💻", "📺", "📷", "🎥", "🎬", "🎤", "🎧", "🎸", "🎹", "🥁", "📚", "✏️", "📞", "💡", "🕯️",
  "🗡️", "🛡️", "🔑", "🔒", "💎", "💰", "💵", "⏰", "🧸", "🎁", "🎈", "🔨", "🧲", "🔬", "🔭", "💊",
  "🚗", "🚕", "🚌", "🚓", "🚑", "🚒", "🚲", "🚂", "✈️", "🚀", "🛸", "⛵", "🚢", "⚓", "🏠", "🏰",
  "🏥", "🏫", "⛪", "🗽", "🗼", "🏝️", "🏔️", "🌋", "⛺", "🎡", "🎢", "🎪", "🏟️", "🌉", "🛣️", "🚦",
  "☀️", "🌙", "⭐", "☁️", "🌧️", "⛈️", "❄️", "🌈", "🔥", "💧", "🌊", "🌪️", "🌸", "🌹", "🌻", "🌲",
  "🌴", "🍀", "❤️", "💔", "💯", "❌", "⭕", "❓", "❗", "➕", "💤", "💥", "💫", "🎵", "🎶", "🏆",
  "🥇", "⚽", "🏀", "🎯", "🎲", "🧩", "👻", "🎃", "🎄", "💍", "👗", "👟", "🎩", "👓", "1️⃣", "2️⃣",
];
