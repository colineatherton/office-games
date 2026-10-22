// Dictionary for Letters Round: common English words, 3–9 letters, lowercase.
// To ADD WORDS: put them anywhere inside the backtick string below, separated
// by spaces or newlines. The list is deduplicated automatically at load time.
// Keep it to words an office crowd would accept — this list is the referee.

const RAW = `
ace aces ache aches aching acid acids acorn acre acres act acted acting action
actions active actor actors acts adapt adapted adapts add added adder adding
adds admit admits adopt adopted adopts adore adored adores adult adults advance
advice advise after again age aged agent agents ages aging ago agree agreed
agrees ahead aid aided aids aim aimed aiming aims air aired airs aisle alarm
alarms album albums alert alerts alias alibi alien aliens alike alive all alley
allow allowed allows ally almond almost alone along aloud alpha already also
alter altered alters always amaze amazed amazes amazing amber amend amount
amounts ample amuse amused ancient and anchor anchors angel angels anger angle
angles angry animal animals ankle ankles annoy annoyed annoys annual answer
answers ant ants any anyone apart ape apes apple apples apply applied april
apron arch arches are area areas arena arenas argue argued argues arise arm
armed armies arming arms army around arrange array arrest arrive arrived arrow
arrows art artist artists arts ash ashes aside ask asked asking asks asleep
aspect assist assume assure ate atlas atom atoms attach attack attacks attempt
attend attic auction audio audit august aunt aunts author authors autumn avenue
avoid avoided avoids await awake award awards aware away awful axe axes baby
back backed backing backs bacon bad badge badges badly bag bags bake baked
baker bakers bakery bakes baking balance bald ball ballet balloon balls bamboo
ban banana bananas band bands bang bank banker banks banned bans bar bare
barely bargain bark barked barks barn barns barrel bars base based bases basic
basics basil basin basis basket baskets bat batch bath bathe baths bats batter
battery battle battles bay bays beach beaches bead beads beak beam beams bean
beans bear beard beards bears beast beasts beat beaten beats beauty became
because become bed beds bee beef been beer beers bees beet before beg began
begin begins begs begun behave behind being beings belief believe bell bells
belly belong below belt belts bench benches bend bends benefit bent berry
beside best bet bets better between beyond bid bids big bigger biggest bike
bikes bill billion bills bin bind bins bird birds birth bit bite bites biting
bits bitter black blade blades blame blamed blames bland blank blanket blast
blaze bleak blend blends bless blew blind blink block blocked blocks blond
blood bloom blossom blow blown blows blue blues blunt blur blush board boards
boast boat boats body boil boiled boils bold bolt bolts bomb bombs bond bonds
bone bones bonus book booked books boom boost boot booth boots border bore
bored boring born borrow boss bosses both bother bottle bottles bottom bought
bounce bound bow bowl bowls bows box boxer boxes boy boys brain brains brake
brakes branch brand brands brave bread break breaks breath breathe breed
breeze brew brick bricks bride bridge bridges brief bright bring brings broad
broke broken bronze brook broom brother brought brow brown brush brushes
bubble bubbles bucket buckets bud budget buds bug bugs build builder builds
built bulb bulbs bulk bull bullet bulls bump bumps bun bunch bundle bunny buns
burden burn burned burning burns burst bus buses bush bushes business busy but
butter button buttons buy buyer buyers buying buys buzz cab cabbage cabin
cabinet cabins cable cables cabs cactus cafe cage cages cake cakes call called
calling calls calm calmly came camel camels camera cameras camp camps can
canal candle candles candy cane canoe cans canvas cap cape caps captain
capture car carbon card cards care cared career careful cares cargo caring
carpet carried carries carrot carrots carry cars cart carton carts carve case
cases cash cast castle castles casual cat catch catchy cats cattle caught
cause caused causes cave caves cease ceiling cell cellar cells cement census
cent center cents century chain chains chair chairs chalk chance change
changes channel chaos chapter charge charm chart charts chase chased chases
chat chats cheap cheat check checked checks cheek cheeks cheer cheese chef
chefs cherry chess chest chests chew chicken chief child chill chilly chin
chip chips choice choir choose chop chops chord chorus chose chosen chrome
chunk church cinema circle circles circus cities citizen city civic civil
claim claimed claims clap clash class classes classic claw claws clay clean
cleaned cleaner cleans clear cleared clearly clerk clever click client cliff
climate climb climbed climbs cling clinic clip clips cloak clock clocks close
closed closer closes closet cloth clothes cloud clouds cloudy clown club clubs
clue clues clumsy coach coal coast coat coats cobweb cocoa code codes coffee
coin coins cold collar collect college colony color colors column comb combine
come comedy comes comet comfort comic coming comma command comment common
company compare compete complex concept concert conduct cone cones confirm
connect consider console contact contain content contest context control cook
cooked cookie cookies cooking cooks cool cooler copied copies copper copy cord
core cork corn corner correct cost costs costume cosy cottage cotton couch
cough could council count counted counter country county couple courage course
court cousin cover covered covers cow cowboy cows crab crabs crack cracked
cracks craft crafts crane crash crate crawl crayon crazy cream create credit
creek creep crept crew cricket cried crime crisis crisp critic crop crops
cross crowd crowded crowds crown crude cruel cruise crumb crunch crush crust
cry crying crystal cub cube cubes cubs cuddle cue cuff cult culture cup
cupboard cups curb cure cured curious curl curly current curry curse curtain
curve curved cushion custom customer cut cute cuts cutting cycle cycles dad
daily dairy daisy damage damp dance danced dancer dances dancing danger dare
dark darker dart dash data date dates dawn day days dead deaf deal dealer
deals dear debate debt debut decade decent decide decided deck decks declare
decline deed deep deeper deer defeat defend define degree delay delayed delays
delete deliver demand dense dental deny depart depend deposit depth derive
desert deserve design desire desk desks dessert detail detect device devote
dial diary dice did diet differ dig digest digit digital digits dine dinner
dip direct dirt dirty disc dish dishes disk dismiss display dispute distance
ditch dive diver divide dizzy dock docks doctor doctors does dog dogs doll
dollar dollars dolls domain done donkey door doors dose dot dots double doubt
dough dove down dozen draft drag dragon dragons drain drama drank draw drawer
drawing drawn draws dream dreams dress dresses drew dried drift drill drink
drinks drive driven driver drivers drives drop dropped drops drove drown drug
drum drums dry dryer duck ducks due duet dug dull dump dune dunes during dust
dusty duty dwarf dwell each eager eagle eagles ear earlier early earn earned
earns ears earth ease easier easily east easter easy eat eaten eating eats
echo edge edges edit editor eel effect effort egg eggs eight either elbow
elder elect electric element elegant elephant eleven elite else elves email
emerge emoji empire employ empty enable end ended ending ends enemy energy
engage engine enjoy enjoyed enjoys enough ensure enter entered enters entire
entry envy equal equip era erase error errors escape essay estate even evening
event events ever every evident evil exact exactly exam exams exceed excel
except excess excite excuse exercise exist exit exits expand expect expense
expert explain explore export expose express extend extent extra eye eyes
fable face faced faces facing fact factor factory facts fade faded fail failed
fails faint fair fairly fairy faith fake fall fallen falls false fame family
famous fan fancy fans far fare farm farmer farmers farms fast faster fat fatal
father fault favor fear feared fears feast feather feature fed fee feed feeds
feel feeling feels fees feet fell fellow felt fence fences fern ferry fetch
fever few fiction field fields fierce fifteen fifth fifty fig fight fighter
fights figs figure file files fill filled fills film films filter final
finally find finding finds fine finest finger fingers finish fire fired fires
firm first fish fisher fishing fist fit fitness fits five fix fixed fixes flag
flags flame flames flash flat flavor flaw fled flee fleet flesh flew flight
flip float flock flood floor floors flour flow flower flowers flown flows flu
fluid flute fly flying foam focus fog foggy foil fold folded folder folds folk
follow fond font food foods fool foot for force forced forces forest forever
forget forgot fork forks form formal format formed forms fort fortune forty
forum forward fossil foster fought found founder four fourth fox foxes frame
frames free freedom freeze fresh friday fridge friend friends fringe frog
frogs from front frost frown froze fruit fruits fry fuel full fully fun fund
funds funny fur furry future fuzzy gain gained gains galaxy gallery game games
gap gaps garage garden gardens garlic gas gate gates gather gave gaze gear
gears gem gems gender gene general genius genre gentle genuine gets getting
ghost ghosts giant giants gift gifts gig giggle ginger girl girls give given
gives giving glad glance glass glasses gleam glide glimpse globe gloom glory
glove gloves glow glue goal goals goat goats goes going gold golden golf gone
good goods goose got gotten gown grab grace grade grades grain grand grant
grape grapes graph grasp grass grave gravity gravy gray great greed green
greet grew grey grid grief grill grim grin grind grip grocery ground group
groups grove grow growing grown grows growth guard guards guess guest guests
guide guided guides guitar gym habit habits had hail hair haircut half hall
halls halt ham hammer hand handed handle hands handy hang hanger happen happy
harbor hard harder hardly harm harsh harvest has hat hatch hate hats haul
haunt have having hawk hay hazard haze hazy head headed heading heads heal
health healthy heap hear heard hearing hears heart hearts heat heated heater
heavy hedge heel heels height held hello helmet help helped helpful helping
helps hen hence her herb herbs herd here hero heroes hers hid hidden hide
high higher highest highway hike hiking hill hills him hint hints hip hire
hired his history hit hits hive hobby hockey hold holder holds hole holes
holiday hollow holy home homes honest honey honor hood hoof hook hooks hop
hope hoped hopes hops horn horns horse horses hose host hosted hosts hot
hotel hotels hour hours house houses hover how however hug huge hugs human
humans humble humid humor hundred hungry hunt hunter hunts hurry hurt hut
huts ice iceberg icing icon icons icy idea ideal ideas igloo ignore ill image
images imagine impact import impose improve inch inches income indeed index
indoor infant inform injury ink inn inner input insect inside insist inspect
install instead intend intent invent invest invite iron island islands issue
issues item items ivory ivy jacket jackets jade jaguar jam jar jars jaw jazz
jeans jelly jet jets jewel jewels job jobs jog join joined joins joint joke
joked jokes jolly journal journey joy judge judged judges juice juicy july
jump jumped jumper jumps june jungle junior junk jury just justice keen keep
keeper keeps kept kettle key keys kick kicked kicks kid kidney kids kind
kindly kinds king kingdom kings kiss kit kitchen kite kites kits kitten kiwi
knee kneel knees knew knife knight knit knock knot know known knows koala lab
label labor lace lack ladder lake lakes lamb lamp lamps land landed lands
lane lanes lap large larger laser last late lately later latest laugh
laughed laughs launch lava law lawn laws lay layer layers layout lazy lead
leader leaders leads leaf league leak lean leap learn learned learns least
leather leave leaves led left leg legacy legal legend legs lemon lemons lend
length lens lent less lesson let lets letter letters lettuce level levels
liar library lid lie lied lies life lift lifted lifts light lights like
liked likely likes limb lime limit limits line linen lines link linked links
lion lions lip lips liquid list listed listen lists lit little live lived
liver lives living lizard load loaded loads loaf loan loans lobby lobster
local locate lock locked locks lodge loft log logic logo logs lone lonely
long longer look looked looking looks loop loose lord lorry lose losing loss
lost lot lots loud lounge love loved lovely lover loves loving low lower
loyal luck lucky lump lunar lunch lungs lure luxury lying machine mad made
magic magnet maid mail main mainly major make maker makes making mall mammal
man manage mango manner manual many map maple maps marble march margin
marine mark marked market marks married marry mask mass master mat match
matches mate math matter mattress may maybe mayor maze meadow meal meals
mean meaning means meant measure meat medal media medium meet meeting meets
mellow melody melon melt member memory men mental mention menu mercy mere
merge merit mermaid merry mess message met metal meter method metro mice mid
middle might mild mile miles milk mill million mind minds mine miner mines
mini minor mint minus minute minutes mirror miss missed misses missing mist
mix mixed mixer mixes mixture moan mobile mock mode model models modern
modest module mole moment monday money monitor monk monkey month months mood
moon moose mop moral more morning moss most mostly motel moth mother motion
motor motto mount mouse mouth move moved moves movie movies moving mud muddy
mug mule multi mum muscle museum music must mutual myself mystery myth
nail nails name named names nap napkin narrow nasty nation native nature
navy near nearby nearly neat neck need needed needle needs nephew nerve nest
net nets network never new newer news next nice nicer niche nickel niece
night nights nine ninja ninth noble nobody nod noise noisy none noodle noon
nor normal north nose not note noted notes nothing notice noun novel now
nowhere number nurse nut nuts oak oasis oats obey object oblige obtain
obvious ocean oceans octopus odd odds off offer offered offers office offset
often oil old older olive omit once one onion onions online only onto open
opened opens opera opinion oppose opt optic option orange orbit orchard
order ordered orders organ origin other others otter ought ounce our out
outcome outdoor outer outfit output outside oval oven over overall owe owed
owl owls own owned owner owns oxygen pace pack package packed packet pad
paddle page pages paid pain paint painted paints pair pairs palace pale palm
pan pancake panda panel panic pans paper papers parade parcel parent park
parked parks parrot part partial parts party pass passed passes passion past
pasta paste pastry pat patch path paths patient pattern pause paw paws pay
payment peace peach peak peanut pear pearl pears peas pedal pen pencil
penguin penny pens people pepper per perch perfect period person pest pet
petal pets phase phone phones photo photos phrase piano pick picked picks
picnic picture pie piece pieces pier pig pigeon pigs pile pilot pin pine
pink pint pins pioneer pipe pipes pirate pit pitch pity pixel pizza place
placed places plain plan plane planet plans plant planted plants plate play
played player players plays plaza pleasant please pledge plenty plot plug
plum plumber plus pocket pod poem poet point points poison polar pole police
policy polish polite poll pond pony pool poor pop popcorn popular porch port
portion pose post poster posts pot potato pots pour powder power praise pray
prefer prepare present press pretty price prices pride priest prime prince
print prior prison private prize probe problem process produce profit
program project promise prompt proof proper protect proud prove proven
public pull pulled pulls pulse pump pumpkin punch pupil puppet puppy pure
purple purpose purse push pushed pushes put puts putting puzzle quality
quarter queen quest question queue quick quickly quiet quietly quilt quit
quite quiz rabbit race raced races racing rack radar radio rage raid rail
rain rained rainbow rains rainy raise raised raisin rally ran ranch random
range rank rapid rare rarely rat rate rates rather rating ratio rats raw ray
rays reach react read reader reading reads ready real really reason rebel
recall recent recipe record red reduce reef refer reform refuse region
regret regular reject relate relax relay release relief rely remain remark
remedy remind remote remove rent repair repeat reply report rescue reserve
resist resort rest result retain retire return reveal review reward rhythm
ribbon rice rich ride rider rides ridge riding right rigid ring rings rinse
riot ripe rise risen rises rising risk risks rival river rivers road roads
roar roast rob robin robot robots rock rocket rocks rode role roles roll
rolled rolls roof room rooms root roots rope ropes rose roses rotate rough
round route row rows royal rub rubber rude rug rugby ruin rule ruled ruler
rules run runner running runs rural rush rust sad saddle sadly safe safely
safety said sail sailor saint salad salary sale sales salmon salon salt
salty same sample sand sandal sandy sang sat sauce sauna sausage save saved
saves saving saw say saying says scale scan scar scarce scare scared scarf
scene scenery scent school science score scored scores scout scrap scratch
screen script sea seal search season seat seats second secret sector secure
see seed seeds seeing seek seem seemed seems seen sees seldom select self
sell seller sells send sense sent series serious serve served serves service
set sets setting settle seven several shade shadow shake shall shallow shame
shape shaped shapes share shared shares shark sharp she shed sheep sheet
shelf shell shelter shift shine shiny ship ships shirt shock shoe shoes
shone shook shop shops shore short should shout show showed shower shown
shows shut shy sick side sides sigh sight sign signal signed signs silence
silent silk silly silver simple since sing singer single sink sir sister
sit site sites sits sitting six size sizes skate sketch ski skies skill
skills skin skip skirt sky slang sleep sleeps sleeve slept slice slide
slight slim slip slope slow slowly small smart smell smile smiled smiles
smoke smooth snack snail snake snakes snap sneeze snow snowy soap soccer
social sock socks sofa soft softly soil solar sold soldier sole solid solo
solve solved some son song songs soon sore sorry sort sorts soul sound
sounds soup sour source south space spare spark speak special speech speed
spell spend spent spice spicy spider spin spine spiral spirit spite split
spoke spoken sponge spoon sport sports spot spots spray spread spring spy
square squash squeeze stable stack staff stage stain stairs stake stamp
stand stands star stare stars start started starts state states station
statue stay stayed stays steady steak steal steam steel steep stem step
steps stew stick sticky stiff still sting stir stock stole stomach stone
stones stood stool stop stopped stops store stored stores storm story
stove straw stream street stress stretch strict strike string strong
struck student studio study stuff stumble style styles subject submit
subtle suburb subway such sudden sugar suit suits sum summer summit sun
sunday sunny sunset super supper supply support sure surely surf surface
surgeon survey survive swallow swam swamp swan swap sweat sweep sweet
swift swim swing switch sword symbol system table tables tackle tact tail
tails take taken takes taking tale talent tales talk talked talks tall
taller tank tanks tap tape target task tasks taste tasty taught tax taxi
tea teach teacher team teams tear tears tease tech teeth tell tells temple
ten tender tennis tent tenth tents term terms test tested tests text thank
thanks that the theater theft their theme then theory there these they
thick thief thin thing things think thinks third thirst thirty this thorn
those though thought thread threat three threw thrill throat throne
through throw thrown thumb thunder thus ticket tide tidy tie tied tiger
tigers tight tile tiles till timber time timer times tin tiny tip tips
tire tired tissue title titles toad toast today toe toes tofu together
token told tomato tomorrow ton tone tongue tonight too took tool tools
tooth top topic topics tops torch total touch tough tour tourist toward
towel tower town towns toy toys trace track tracks trade traffic trail
train trains trap trash travel tray treat treaty tree trees trek trend
trial tribe trick tricky tried tries trim trip trips troop trophy tropical
trouble truck trucks true truly trumpet trunk trust truth try trying tube
tulip tummy tuna tune tunnel turkey turn turned turns turtle twelve twenty
twice twin twins twist two type types typical ugly umbrella uncle under
union unique unit unite units unity until unusual update upon upper upset
urban urge urgent usage use used useful user users uses using usual
usually utter vacuum vague valid valley value values van vanilla vapor
various vast vault vector vein velvet vendor verb verse version very vest
via victim victory video view viewer views village vine vinegar violin
virtue virus visa visible vision visit visitor visual vital vivid vocal
voice voices volcano volume vote voted voter votes vowel voyage wage wagon
waist wait waited waiter waits wake walk walked walker walks wall wallet
walls walnut wander want wanted wants war warm warmth warn warned wash
washed waste watch water waters wave waved waves wax way ways weak wealth
weapon wear weather weave web website wedding week weekend weekly weeks
weigh weight weird welcome well went were west wet whale what wheat wheel
wheels when where which while whisper white who whole whom whose why wide
widely widow width wild will willing win wind window windows winds windy
wine wing wings winner winter wipe wire wired wires wisdom wise wish
wished wishes wit witch with within without witness wizard woke wolf
wolves woman women won wonder wood wooden woods wool word words wore work
worked worker working works world worm worn worry worse worst worth would
wound woven wrap wreck wrist write writer writes writing written wrong
wrote yacht yard yards yarn yawn year yearly years yeast yellow yes yet
yield yoga young your yours youth zebra zero zest zigzag zinc zone zones
zoo zoom
`;

export const WORDS = [...new Set(RAW.toLowerCase().split(/\s+/).filter(Boolean))];
