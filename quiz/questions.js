// Built-in question pack for Quiz Buzzer. {category, question, answer}.
// Add your own — office in-jokes make the best rounds.

export const QUESTIONS = [
  // Geography
  { category: "Geography", question: "What is the capital of Australia?", answer: "Canberra" },
  { category: "Geography", question: "What is the capital of Canada?", answer: "Ottawa" },
  { category: "Geography", question: "What is the capital of Spain?", answer: "Madrid" },
  { category: "Geography", question: "What is the capital of Italy?", answer: "Rome" },
  { category: "Geography", question: "Which is the largest ocean on Earth?", answer: "The Pacific Ocean" },
  { category: "Geography", question: "Which is the smallest country in the world?", answer: "Vatican City" },
  { category: "Geography", question: "Which country's flag features a red maple leaf?", answer: "Canada" },
  { category: "Geography", question: "Mount Fuji is in which country?", answer: "Japan" },
  { category: "Geography", question: "The Great Barrier Reef lies off the coast of which country?", answer: "Australia" },
  { category: "Geography", question: "In which city would you find the Leaning Tower?", answer: "Pisa" },
  { category: "Geography", question: "The Pyramids of Giza are in which country?", answer: "Egypt" },
  { category: "Geography", question: "Which US state is the Grand Canyon in?", answer: "Arizona" },
  { category: "Geography", question: "Rio de Janeiro and São Paulo are cities in which country?", answer: "Brazil" },
  { category: "Geography", question: "What is the largest hot desert in the world?", answer: "The Sahara" },
  { category: "Geography", question: "What is the longest river in Africa?", answer: "The Nile" },
  { category: "Geography", question: "In which city is the Eiffel Tower?", answer: "Paris" },
  { category: "Geography", question: "Which country gifted the Statue of Liberty to the USA?", answer: "France" },

  // Science & nature
  { category: "Science", question: "What is the largest planet in our solar system?", answer: "Jupiter" },
  { category: "Science", question: "Which planet is known as the Red Planet?", answer: "Mars" },
  { category: "Science", question: "Which planet is closest to the Sun?", answer: "Mercury" },
  { category: "Science", question: "What is the chemical symbol 'Au' for?", answer: "Gold" },
  { category: "Science", question: "What does 'H2O' commonly refer to?", answer: "Water" },
  { category: "Science", question: "What is the hardest natural substance on Earth?", answer: "Diamond" },
  { category: "Science", question: "What is the first element on the periodic table?", answer: "Hydrogen" },
  { category: "Science", question: "Which gas do plants absorb from the atmosphere for photosynthesis?", answer: "Carbon dioxide" },
  { category: "Science", question: "At sea level, what is the boiling point of water in Celsius?", answer: "100 degrees" },
  { category: "Science", question: "How many bones are in the adult human body?", answer: "206" },
  { category: "Science", question: "Which organ pumps blood around the human body?", answer: "The heart" },
  { category: "Science", question: "What is the closest star to Earth?", answer: "The Sun" },
  { category: "Nature", question: "What is the fastest land animal?", answer: "The cheetah" },
  { category: "Nature", question: "How many legs does a spider have?", answer: "Eight" },
  { category: "Nature", question: "What is the largest animal ever known to have lived?", answer: "The blue whale" },
  { category: "Nature", question: "Which flightless seabird is famous for living in Antarctica?", answer: "The penguin" },

  // Movies & TV
  { category: "Movies", question: "Who directed the 1993 film Jurassic Park?", answer: "Steven Spielberg" },
  { category: "Movies", question: "\"May the Force be with you\" is from which film series?", answer: "Star Wars" },
  { category: "Movies", question: "Which Pixar film is about a clownfish searching for his son?", answer: "Finding Nemo" },
  { category: "Movies", question: "Who played Jack in the 1997 film Titanic?", answer: "Leonardo DiCaprio" },
  { category: "Movies", question: "In The Lion King, what is the name of Simba's father?", answer: "Mufasa" },
  { category: "TV", question: "The US version of The Office is set at which paper company?", answer: "Dunder Mifflin" },
  { category: "Movies", question: "Which Marvel superhero is nicknamed the Web-Slinger?", answer: "Spider-Man" },

  // Music
  { category: "Music", question: "John, Paul, George and Ringo were members of which band?", answer: "The Beatles" },
  { category: "Music", question: "Which instrument has 88 keys?", answer: "The piano" },
  { category: "Music", question: "Which singer was known as the King of Pop?", answer: "Michael Jackson" },
  { category: "Music", question: "Who sang the 2010 hit \"Rolling in the Deep\"?", answer: "Adele" },
  { category: "Music", question: "Which composer wrote the Ninth Symphony featuring the \"Ode to Joy\"?", answer: "Beethoven" },

  // Sport
  { category: "Sport", question: "How many players are on the pitch per team in a football (soccer) match?", answer: "Eleven" },
  { category: "Sport", question: "How many rings are on the Olympic flag?", answer: "Five" },
  { category: "Sport", question: "In tennis, what word is used for a score of zero?", answer: "Love" },
  { category: "Sport", question: "In which sport would you hit a home run?", answer: "Baseball" },
  { category: "Sport", question: "How many holes are played in a full round of golf?", answer: "Eighteen" },
  { category: "Sport", question: "Which martial art's name means 'gentle way' in Japanese?", answer: "Judo" },

  // Food & drink
  { category: "Food", question: "Sushi originates from which country?", answer: "Japan" },
  { category: "Food", question: "What is the main ingredient of guacamole?", answer: "Avocado" },
  { category: "Food", question: "Which nut is the key flavour of Nutella?", answer: "Hazelnut" },
  { category: "Food", question: "Which cheese is traditionally used on a Margherita pizza?", answer: "Mozzarella" },
  { category: "Food", question: "Which Italian dish is made of layered pasta sheets, meat sauce and béchamel?", answer: "Lasagne" },

  // History
  { category: "History", question: "Who was the first person to walk on the Moon?", answer: "Neil Armstrong" },
  { category: "History", question: "In which year did World War II end?", answer: "1945" },
  { category: "History", question: "Which famous ship sank on its maiden voyage in 1912?", answer: "The Titanic" },
  { category: "History", question: "Who was the first President of the United States?", answer: "George Washington" },
  { category: "History", question: "Who painted the Mona Lisa?", answer: "Leonardo da Vinci" },
  { category: "History", question: "Who wrote the play Romeo and Juliet?", answer: "William Shakespeare" },

  // Tech
  { category: "Tech", question: "Which company makes the iPhone?", answer: "Apple" },
  { category: "Tech", question: "What does 'WWW' stand for?", answer: "World Wide Web" },
  { category: "Tech", question: "Who co-founded Microsoft with Paul Allen?", answer: "Bill Gates" },
  { category: "Tech", question: "What does 'CPU' stand for?", answer: "Central Processing Unit" },
  { category: "Tech", question: "Larry Page and Sergey Brin founded which company?", answer: "Google" },

  // General knowledge
  { category: "General", question: "How many sides does a hexagon have?", answer: "Six" },
  { category: "General", question: "How many minutes are there in a full day?", answer: "1440" },
  { category: "General", question: "What is the currency of Japan?", answer: "The yen" },
  { category: "General", question: "Which language has the most native speakers in the world?", answer: "Mandarin Chinese" },
  { category: "General", question: "How many colours are traditionally said to be in a rainbow?", answer: "Seven" },
];
