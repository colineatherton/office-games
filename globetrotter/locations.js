// Locations for Globetrotter.
//
// STREETVIEW_SPOTS: world-famous outdoor spots with reliable Google Street View
// coverage (no mainland China / Cuba — no coverage there). Coordinates are the
// landmark itself; the game snaps to the nearest panorama within 200 m and the
// host's client skips a spot defensively if no imagery is found.
//
// CLUE_SPOTS: famous places with four progressive clues, cryptic → giveaway.
// A clue must never contain the answer's name.

export const STREETVIEW_SPOTS = [
  { name: "Times Square, New York", lat: 40.758, lng: -73.9855 },
  { name: "Abbey Road crossing, London", lat: 51.532, lng: -0.1778 },
  { name: "Shibuya Crossing, Tokyo", lat: 35.6595, lng: 139.7005 },
  { name: "Brandenburg Gate, Berlin", lat: 52.5163, lng: 13.3777 },
  { name: "Sydney Opera House, Sydney", lat: -33.8568, lng: 151.2153 },
  { name: "Eiffel Tower, Paris", lat: 48.8584, lng: 2.2945 },
  { name: "Colosseum, Rome", lat: 41.8902, lng: 12.4922 },
  { name: "Sagrada Família, Barcelona", lat: 41.4036, lng: 2.1744 },
  { name: "Red Square, Moscow", lat: 55.7539, lng: 37.6208 },
  { name: "Golden Gate Bridge vista, San Francisco", lat: 37.8324, lng: -122.4795 },
  { name: "Hollywood Boulevard, Los Angeles", lat: 34.1022, lng: -118.341 },
  { name: "The Strip, Las Vegas", lat: 36.1126, lng: -115.1767 },
  { name: "Mather Point, Grand Canyon", lat: 36.0616, lng: -112.1078 },
  { name: "Niagara Falls (Canadian side)", lat: 43.0896, lng: -79.0849 },
  { name: "Christ the Redeemer, Rio de Janeiro", lat: -22.9519, lng: -43.2105 },
  { name: "Copacabana Beach, Rio de Janeiro", lat: -22.9711, lng: -43.1822 },
  { name: "Obelisco, Buenos Aires", lat: -34.6037, lng: -58.3816 },
  { name: "Machu Picchu, Peru", lat: -13.1631, lng: -72.545 },
  { name: "Zócalo, Mexico City", lat: 19.4326, lng: -99.1332 },
  { name: "V&A Waterfront, Cape Town", lat: -33.9036, lng: 18.4208 },
  { name: "Pyramids of Giza, Egypt", lat: 29.9773, lng: 31.1325 },
  { name: "Jemaa el-Fnaa, Marrakesh", lat: 31.6258, lng: -7.9891 },
  { name: "Burj Khalifa, Dubai", lat: 25.1972, lng: 55.2744 },
  { name: "Western Wall plaza, Jerusalem", lat: 31.7767, lng: 35.2345 },
  { name: "Hagia Sophia, Istanbul", lat: 41.0086, lng: 28.9802 },
  { name: "Acropolis, Athens", lat: 37.9715, lng: 23.7267 },
  { name: "Oia, Santorini", lat: 36.4618, lng: 25.3753 },
  { name: "St Mark's Square, Venice", lat: 45.434, lng: 12.3388 },
  { name: "Leaning Tower of Pisa", lat: 43.723, lng: 10.3966 },
  { name: "Dam Square, Amsterdam", lat: 52.3731, lng: 4.8926 },
  { name: "Grand Place, Brussels", lat: 50.8467, lng: 4.3525 },
  { name: "Charles Bridge, Prague", lat: 50.0865, lng: 14.4114 },
  { name: "Stephansplatz, Vienna", lat: 48.2085, lng: 16.3725 },
  { name: "Hungarian Parliament, Budapest", lat: 47.5076, lng: 19.0458 },
  { name: "Nyhavn, Copenhagen", lat: 55.6798, lng: 12.5912 },
  { name: "Gamla Stan, Stockholm", lat: 59.3251, lng: 18.0711 },
  { name: "Hallgrímskirkja, Reykjavik", lat: 64.1417, lng: -21.9266 },
  { name: "Royal Mile, Edinburgh", lat: 55.9496, lng: -3.19 },
  { name: "Temple Bar, Dublin", lat: 53.3453, lng: -6.2634 },
  { name: "Praça do Comércio, Lisbon", lat: 38.7077, lng: -9.1365 },
  { name: "Puerta del Sol, Madrid", lat: 40.4169, lng: -3.7035 },
  { name: "Merlion Park, Singapore", lat: 1.2868, lng: 103.8545 },
  { name: "Tsim Sha Tsui promenade, Hong Kong", lat: 22.2934, lng: 114.1722 },
  { name: "Gyeongbokgung Palace, Seoul", lat: 37.5796, lng: 126.977 },
  { name: "Taipei 101, Taipei", lat: 25.033, lng: 121.5645 },
  { name: "Grand Palace, Bangkok", lat: 13.75, lng: 100.4913 },
  { name: "Petronas Towers, Kuala Lumpur", lat: 3.1579, lng: 101.7116 },
  { name: "India Gate, Delhi", lat: 28.6129, lng: 77.2295 },
  { name: "Gateway of India, Mumbai", lat: 18.922, lng: 72.8347 },
  { name: "Sky Tower, Auckland", lat: -36.8485, lng: 174.7622 },
  { name: "Queenstown waterfront, New Zealand", lat: -45.0312, lng: 168.6626 },
  { name: "Gastown steam clock, Vancouver", lat: 49.2844, lng: -123.1089 },
  { name: "CN Tower, Toronto", lat: 43.6426, lng: -79.3871 },
  { name: "Cloud Gate, Chicago", lat: 41.8827, lng: -87.6233 },
  { name: "Lincoln Memorial, Washington DC", lat: 38.8893, lng: -77.0502 },
  { name: "Avenida Paulista, São Paulo", lat: -23.5614, lng: -46.6559 },
  { name: "Marienplatz, Munich", lat: 48.1374, lng: 11.5755 },
  { name: "Main Market Square, Kraków", lat: 50.0617, lng: 19.9373 },
  { name: "Sensō-ji temple, Tokyo", lat: 35.7148, lng: 139.7967 },
  { name: "Fushimi Inari shrine, Kyoto", lat: 34.9671, lng: 135.7727 },
  { name: "Chapel Bridge, Lucerne", lat: 47.0517, lng: 8.3075 },
];

export const CLUE_SPOTS = [
  { name: "Paris", lat: 48.8566, lng: 2.3522, clues: [
    "This European capital sits on a river crossed by thirty-seven bridges.",
    "Its most famous landmark was built for an 1889 world's fair and was meant to be temporary.",
    "Home to the Louvre, a glass pyramid, and world-class croissants.",
    "The capital of France, with a very famous iron tower." ] },
  { name: "London", lat: 51.5074, lng: -0.1278, clues: [
    "Romans founded this city two thousand years ago on a muddy river.",
    "Its underground railway is the oldest in the world, opened in 1863.",
    "Red buses, black cabs, and a giant Ferris wheel on the south bank.",
    "The capital of the United Kingdom, where a famous clock tower chimes." ] },
  { name: "New York City", lat: 40.7128, lng: -74.006, clues: [
    "This city was once called New Amsterdam.",
    "A French gift stands in its harbour holding a torch.",
    "Yellow cabs, a giant green park in the middle, and Broadway shows.",
    "The Big Apple, in the USA." ] },
  { name: "Tokyo", lat: 35.6762, lng: 139.6503, clues: [
    "The world's most populous metropolitan area, rebuilt twice in one century.",
    "Its busiest pedestrian crossing moves thousands of people per green light.",
    "Sushi, bullet trains, and cherry blossoms in spring.",
    "The capital of Japan." ] },
  { name: "Sydney", lat: -33.8688, lng: 151.2093, clues: [
    "This harbour city was founded as a penal colony in 1788.",
    "Its most famous building looks like white sails and hosts operas.",
    "Bondi Beach is a bus ride from downtown.",
    "Australia's largest city (not its capital!)." ] },
  { name: "Rio de Janeiro", lat: -22.9068, lng: -43.1729, clues: [
    "This city's name means 'January River' — though there's no river.",
    "A 30-metre statue watches it from a mountain called Corcovado.",
    "Famous for carnival, samba, and a beach called Copacabana.",
    "Brazil's second city, host of the 2016 Olympics." ] },
  { name: "Cairo", lat: 30.0444, lng: 31.2357, clues: [
    "Africa's largest city sprawls along the banks of its longest river.",
    "The last surviving Wonder of the Ancient World is in its suburbs.",
    "Pharaohs, souks, and a very famous sphinx.",
    "The capital of Egypt." ] },
  { name: "Rome", lat: 41.9028, lng: 12.4964, clues: [
    "Legend says two brothers raised by a wolf founded this city.",
    "It contains an entire country within its city limits.",
    "Gladiators once fought in its most famous ruin.",
    "The capital of Italy, the Eternal City." ] },
  { name: "Venice", lat: 45.4408, lng: 12.3155, clues: [
    "This city has over 400 bridges and zero cars in its centre.",
    "Its buses are boats and its taxis are boats.",
    "Masks, canals, and gondoliers in striped shirts.",
    "The floating city of northern Italy." ] },
  { name: "Barcelona", lat: 41.3851, lng: 2.1734, clues: [
    "An architect spent 43 years on this city's cathedral — it's still not finished.",
    "Its grid-planned district has distinctive chamfered street corners.",
    "Tapas, a famous football club, and Gaudí everywhere.",
    "The capital of Catalonia, Spain." ] },
  { name: "Amsterdam", lat: 52.3676, lng: 4.9041, clues: [
    "This city sits below sea level and has more bikes than people.",
    "Its canal ring is a UNESCO World Heritage site.",
    "Tulips, windmills nearby, and very steep staircases.",
    "The capital of the Netherlands." ] },
  { name: "Berlin", lat: 52.52, lng: 13.405, clues: [
    "A wall split this city in two for 28 years.",
    "Its most famous landmark is a gate topped by a four-horse chariot.",
    "Currywurst, techno clubs, and a glass-domed parliament.",
    "The capital of Germany." ] },
  { name: "Moscow", lat: 55.7558, lng: 37.6173, clues: [
    "This city's metro stations look like underground palaces.",
    "A colourful cathedral with onion domes anchors its most famous square.",
    "The Kremlin sits at its heart.",
    "The capital of Russia." ] },
  { name: "Istanbul", lat: 41.0082, lng: 28.9784, clues: [
    "The only major city that straddles two continents.",
    "It has been called Byzantium and Constantinople.",
    "A grand bazaar with over 4,000 shops.",
    "Turkey's largest city, on the Bosphorus." ] },
  { name: "Athens", lat: 37.9838, lng: 23.7275, clues: [
    "Democracy was invented in this city about 2,500 years ago.",
    "A ruined temple to a wisdom goddess crowns its central hill.",
    "It hosted the first modern Olympic Games in 1896.",
    "The capital of Greece." ] },
  { name: "Dubai", lat: 25.2048, lng: 55.2708, clues: [
    "Fifty years ago this city was a small fishing and pearling town.",
    "It built islands shaped like a palm tree.",
    "Home to the world's tallest building and an indoor ski slope.",
    "The glitziest city of the United Arab Emirates." ] },
  { name: "Singapore", lat: 1.3521, lng: 103.8198, clues: [
    "A city, an island, and a country all at once.",
    "Chewing gum is famously banned here.",
    "A hotel with a ship-shaped roof overlooks its marina.",
    "The Lion City, at the tip of the Malay Peninsula." ] },
  { name: "Hong Kong", lat: 22.3193, lng: 114.1694, clues: [
    "This city has more skyscrapers than any other on Earth.",
    "Double-decker trams rattle through its streets, and a peak tram climbs above them.",
    "Dim sum, neon, and a famous harbour crossed by the Star Ferry.",
    "A special administrative region of China, once British." ] },
  { name: "Beijing", lat: 39.9042, lng: 116.4074, clues: [
    "Emperors ruled from a 'forbidden' palace complex in this city for 500 years.",
    "The world's largest public square sits at its heart.",
    "Peking duck was named after it (sort of).",
    "The capital of China." ] },
  { name: "Mumbai", lat: 19.076, lng: 72.8777, clues: [
    "Seven islands were joined together to build this megacity.",
    "Its film industry releases more movies than Hollywood.",
    "A basalt arch on its waterfront welcomed ships to the Raj.",
    "India's largest city, formerly called Bombay." ] },
  { name: "Bangkok", lat: 13.7563, lng: 100.5018, clues: [
    "This city's full ceremonial name is 168 letters long.",
    "Tuk-tuks weave between golden temples and street-food carts.",
    "A reclining Buddha here is 46 metres long.",
    "The capital of Thailand." ] },
  { name: "Seoul", lat: 37.5665, lng: 126.978, clues: [
    "A river runs through this city that was paved over, then un-paved into a park.",
    "Half the country's population lives in its metropolitan area.",
    "Kimchi, K-pop, and five grand palaces.",
    "The capital of South Korea." ] },
  { name: "Cape Town", lat: -33.9249, lng: 18.4241, clues: [
    "A famous flat-topped mountain wears a 'tablecloth' of cloud over this city.",
    "Penguins live on one of its beaches.",
    "A notorious island prison sits in its bay.",
    "South Africa's mother city." ] },
  { name: "Marrakesh", lat: 31.6295, lng: -7.9811, clues: [
    "This city's medina is a maze of souks under the Atlas Mountains.",
    "Its main square fills with storytellers and snake charmers at dusk.",
    "Mint tea, riads, and rose-coloured walls.",
    "Morocco's red city." ] },
  { name: "Reykjavik", lat: 64.1466, lng: -21.9426, clues: [
    "The world's northernmost capital city.",
    "Hot water for its homes comes straight out of the ground.",
    "A rocket-shaped church towers over its colourful roofs.",
    "The capital of Iceland." ] },
  { name: "Mexico City", lat: 19.4326, lng: -99.1332, clues: [
    "This capital is built on a drained lake and is slowly sinking.",
    "The Aztecs called it Tenochtitlan.",
    "Tacos al pastor and a giant flag in its main square.",
    "The capital of the big country directly south of the USA." ] },
  { name: "Buenos Aires", lat: -34.6037, lng: -58.3816, clues: [
    "The 'Paris of South America', famous for a dance invented in its ports.",
    "Its widest avenue has up to 14 lanes.",
    "Steak, tango, and brightly painted houses in La Boca.",
    "The capital of Argentina." ] },
  { name: "Lima", lat: -12.0464, lng: -77.0428, clues: [
    "This capital almost never sees rain, despite sitting on an ocean.",
    "Conquistador Francisco Pizarro founded it in 1535.",
    "Ceviche was born here, and the city is proud of it.",
    "The capital of Peru." ] },
  { name: "Toronto", lat: 43.6532, lng: -79.3832, clues: [
    "More than half the residents of this city were born outside the country.",
    "A concrete tower here was the world's tallest free-standing structure for 32 years.",
    "Its hockey team is loved and cursed in equal measure.",
    "Canada's largest city, on Lake Ontario." ] },
  { name: "Vancouver", lat: 49.2827, lng: -123.1207, clues: [
    "You can ski and sail on the same day in this Pacific city.",
    "A 400-hectare forest park sits right beside downtown.",
    "It regularly tops 'most liveable city' lists.",
    "Canada's west-coast gem, in British Columbia." ] },
  { name: "San Francisco", lat: 37.7749, lng: -122.4194, clues: [
    "This city's fog is so famous it has a name: Karl.",
    "Historic cable cars still climb its absurdly steep streets.",
    "A former island prison sits in its bay.",
    "The Golden Gate city, in California." ] },
  { name: "Los Angeles", lat: 34.0522, lng: -118.2437, clues: [
    "This city's name is a shortened version of a much longer Spanish one.",
    "Giant white letters on a hillside advertise its most famous industry.",
    "Stars are embedded in its most famous sidewalk.",
    "The City of Angels, in California." ] },
  { name: "Las Vegas", lat: 36.1699, lng: -115.1398, clues: [
    "This desert city has more hotel rooms than any other on Earth.",
    "You can see a pyramid, the Eiffel Tower, and Venice without leaving one street.",
    "What happens here, stays here.",
    "Nevada's neon playground." ] },
  { name: "Chicago", lat: 41.8781, lng: -87.6298, clues: [
    "This city reversed the flow of its own river.",
    "The skyscraper was invented here after a great fire.",
    "Deep-dish pizza and a giant mirrored bean sculpture.",
    "The Windy City, on Lake Michigan." ] },
  { name: "New Orleans", lat: 29.9511, lng: -90.0715, clues: [
    "Much of this city lies below the level of the river beside it.",
    "Jazz was born in its streets.",
    "Beignets, voodoo lore, and a famous French Quarter.",
    "Louisiana's party capital, home of Mardi Gras." ] },
  { name: "Honolulu", lat: 21.3069, lng: -157.8583, clues: [
    "This is the most isolated major city on the planet.",
    "A famous naval harbour nearby was attacked in 1941.",
    "Surfing was practically invented on its beaches.",
    "The capital of Hawaii." ] },
  { name: "Edinburgh", lat: 55.9533, lng: -3.1883, clues: [
    "A castle on an extinct volcano dominates this city.",
    "It hosts the world's largest arts festival every August.",
    "A loyal dog called Bobby has a statue here.",
    "The capital of Scotland." ] },
  { name: "Dublin", lat: 53.3498, lng: -6.2603, clues: [
    "A thousand-year-old book of gospels is this city's top attraction.",
    "A certain dark stout has been brewed here since 1759.",
    "Its Georgian doors come in every colour.",
    "The capital of Ireland." ] },
  { name: "Lisbon", lat: 38.7223, lng: -9.1393, clues: [
    "This city was almost completely destroyed by an earthquake in 1755.",
    "Yellow trams climb its seven hills.",
    "Custard tarts and melancholy fado music.",
    "The capital of Portugal." ] },
  { name: "Madrid", lat: 40.4168, lng: -3.7038, clues: [
    "This is Europe's highest capital city, at 650 metres.",
    "A bear reaching for a strawberry tree is its symbol.",
    "Two giant football clubs, one famous art triangle.",
    "The capital of Spain." ] },
  { name: "Vienna", lat: 48.2082, lng: 16.3738, clues: [
    "Beethoven, Mozart, and Freud all worked in this city.",
    "Its coffee houses are listed as cultural heritage.",
    "A giant Ferris wheel from 1897 still turns in its Prater park.",
    "The capital of Austria, on the Danube." ] },
  { name: "Prague", lat: 50.0755, lng: 14.4378, clues: [
    "An astronomical clock has performed hourly in this city since 1410.",
    "Its castle is the largest ancient castle complex in the world.",
    "The city of a hundred spires, famous for its beer.",
    "The capital of the Czech Republic." ] },
  { name: "Budapest", lat: 47.4979, lng: 19.0402, clues: [
    "This capital is actually two old cities separated by a river.",
    "It has more thermal springs than any other capital.",
    "A chain bridge guarded by stone lions links its two halves.",
    "The capital of Hungary." ] },
  { name: "Stockholm", lat: 59.3293, lng: 18.0686, clues: [
    "This capital is spread across fourteen islands.",
    "Nobel Prizes are handed out here every December.",
    "A 17th-century warship that sank on launch day fills one of its museums.",
    "The capital of Sweden." ] },
  { name: "Oslo", lat: 59.9139, lng: 10.7522, clues: [
    "You can walk onto the sloping marble roof of this city's opera house.",
    "A park here contains 212 sculptures of very expressive naked people.",
    "The Nobel Peace Prize is awarded here, not in its neighbour's capital.",
    "The capital of Norway." ] },
  { name: "Helsinki", lat: 60.1699, lng: 24.9384, clues: [
    "A church in this capital is carved directly into solid rock.",
    "Its residents hold the title of happiest people on Earth, allegedly.",
    "Saunas outnumber cars in its home country.",
    "The capital of Finland." ] },
  { name: "Petra", lat: 30.3285, lng: 35.4444, clues: [
    "You enter this ancient city through a kilometre-long rock crevice.",
    "Its buildings are carved straight into rose-red cliffs.",
    "It starred in an Indiana Jones finale.",
    "Jordan's lost city of stone." ] },
  { name: "Kathmandu", lat: 27.7172, lng: 85.324, clues: [
    "This capital sits in a bowl-shaped valley a mile above sea level.",
    "Climbers stock up here before attempting the world's highest peaks.",
    "Prayer flags, stupas, and temple monkeys everywhere.",
    "The capital of Nepal." ] },
  { name: "Easter Island", lat: -27.1127, lng: -109.3497, clues: [
    "The nearest inhabited land to this island is 2,000 km away.",
    "Nearly 900 giant stone heads (with bodies!) stand on its slopes.",
    "Its Polynesian name is Rapa Nui.",
    "A remote Chilean island famous for moai statues." ] },
  { name: "Cairns", lat: -16.9186, lng: 145.7781, clues: [
    "This tropical town is the gateway to the world's largest living structure.",
    "The reef offshore is visible from space.",
    "Snorkels, stingers, and sugar cane.",
    "Queensland, Australia — doorway to the Great Barrier Reef." ] },
];
