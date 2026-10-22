// Dictionary of common 4-letter English words for Word Ladder Race.
// Deliberately curated: everyday words only, office-friendly. To add words,
// append them to the string below (lowercase, exactly 4 letters) — the loader
// dedupes automatically. PUZZLES are BFS-verified against this exact list;
// if you remove words, re-check the puzzles still solve.

const RAW = `
able ache acid acre aged ages aide aids aims airs airy ajar akin ally also alto
amen amid anew ante ants apes apex aqua arch area arid arks arms army arts atom
aunt auto avid away axes axis axle babe baby back bail bait bake bald bale ball
balm band bane bang bank bans barb bard bare bark barn bars base bash bask bass
bath bats bead beak beam bean bear beat beds beef been beep beer bees beet begs
hate gate fate mate
bell belt bend bent best bets bias bibs bids bike bile bill bind bins bird bite
bits blab bled blew blip blob bloc blog blot blow blue blur boar boat bobs bode
body boil bold bolt bomb bond bone bony book boom boon boot bore born boss both
bout bowl bows brag bran brat bred brew brim brow buck buds buff bugs bulb bulk
bull bump bunk buns burn burp bury bush bust busy buts buzz byte cabs cafe cage
cake calf call calm came camp cane cans cape caps card care carp cars cart case
cash cask cast cats cave cell cent chap char chat chef chew chic chin chip chop
chug cite city clad clam clan clap claw clay clip clog clot club clue coal coat
coax cobs code coil coin coke cold colt comb come cone cook cool cope cops copy
cord core cork corn cost cove cows cozy crab crag cram crew crib crop crow crux
cube cubs cues cuff cult cups curb cure curl cuts dabs dads daft dais dame damp
dare dark darn dart dash data date dawn days daze dead deaf deal dean dear debt
deck deed deem deep deer deft defy dell demo dent deny desk dial dice died dies
diet digs dime dine ding dips dire dirt disc dish disk dive dock docs dodo does
dogs dole doll dome done doom door dorm dose dots dove down doze drab drag dram
draw drew drip drop drum dual duck duct dude duel dues duet duke dull duly dumb
dump dune dunk dusk dust duty dyed dyes each earl earn ears ease east easy eats
echo edge edgy edit eels eggs egos elks elms else emit ends envy epic eras ergo
euro even ever eves evil exam exit expo eyed eyes face fact fade fads fail fair
fake fall fame fang fans fare farm fast fate fats fawn fear feat feed feel fees
feet fell felt fend fern feud figs file fill film find fine fins fire firm fish
fist fits five fizz flag flak flap flat flaw flax flea fled flee flew flex flip
flit flop flow flue flux foal foam foes fogs foil fold folk fond font food fool
foot fore fork form fort foul four fowl foxy fray free fret frog from fuel full
fume fund funk fury fuse fuss fuzz gain gait gala gale gall game gang gaps garb
gash gasp gate gaze gear geek gels gems gene gent germ gift gigs gild gill girl
gist give glad glee glen glob glow glue gnat goal goat goes gold golf gone gong
good goof gown grab gram gray grew grey grid grim grin grip grit grow grub gulf
gull gulp gums guru gush gust guts guys gyms hack hail hair hale half hall halo
halt hand hang hard hare harm harp hash hats haul have hawk haze hazy head heal
heap hear heat heed heel heir held helm help hemp hens herb herd here hero hers
hide high hike hill hind hint hire hiss hits hive hoax hobo hogs hold hole holy
home hone hood hoof hook hoop hope hops horn hose host hour howl hubs hues huff
huge hugs hula hulk hull hump hums hunt hurl hurt hush huts hymn hype iced ices
icon idea idle idly idol inch info inky inns into ions iris iron isle itch item
jabs jack jade jail jams jars jaws jazz jeep jeer jest jets jigs jinx jive jobs
jogs join joke jolt jots joys judo jugs jump junk jury just jute kale keel keen
keep kegs kelp kept keys kick kids kiln kilt kind king kiss kite kits kiwi knee
knew knit knob knot know labs lace lack lacy lads lady laid lair lake lamb lame
lamp land lane laps lard lark lash lass last late lava lawn laws lays lazy lead
leaf leak lean leap left legs lend lens lent less lest lets levy liar lice lick
lids lies life lift like lily limb lime limp line link lint lion lips lisp list
live load loaf loan lobe lock loft logo logs lone long look loom loop loot lord
lore lose loss lost lots loud love lows luck lull lump lung lure lurk lush lute
lynx mace made maid mail main make male mall malt mane many maps mare mark mash
mask mass mast mate math mats maul maze mead meal mean meat meek meet meld melt
memo mend menu meow mere mesh mess mice mild mile milk mill mime mind mine mint
miss mist mite mitt moan moat mobs mock mode mold mole molt monk mood moon moor
moot mope more morn moss most moth move much muck mugs mule muse mush must mute
myth nags nail name nape naps navy near neat neck need neon nest nets news next
nice nick nigh nine node nods none nook noon norm nose note noun nova numb nuns
nuts oaks oars oath oats obey oboe odds odor ogre oils oily oink okay okra omen
omit once ones only onto onus onyx ooze opal open opts oral orbs orca ouch ours
oust outs oval oven over owed owes owls owns oxen pace pack pact pads page paid
pail pain pair pale palm pane pang pans pant park part pass past path pats pave
pawn paws pays peak peal pear peas peat peck peek peel peer pegs pelt pens pent
perk pest pets pews pick pier pigs pike pile pill pine ping pink pins pint pipe
pits pity plan play plea plod plop plot plow ploy plug plum plus pods poem poet
poke pole poll polo pond pony pool poor pope pops pore pork port pose posh post
pots pour pout pray prep prey prim prod prop pros prow pubs puck puff pull pulp
pump punt puny pups pure purr push puts putt quad quay quip quit quiz race rack
racy raft rage rags raid rail rain rake ramp rang rank rant raps rare rash rate
rats rave rays raze read real ream reap rear redo reed reef reel rein rely rend
rent rest ribs rice rich ride rife rift rigs rims rind ring rink riot ripe rise
risk rite road roam roar robe rock rode rods role roll roof rook room root rope
rose rosy rots rout rows rubs ruby rude rugs ruin rule rump rung runs runt ruse
rush rust ruts sack safe saga sage said sail sake sale salt same sand sane sang
sank saps sash save saws says scam scan scar scat seal seam sear seas seat sect
seed seek seem seen seep sees self sell semi send sent sets sewn shed shin ship
shoe shop shot show shun shut sick side sift sigh sign silk sill silo silt sing
sink sips sire site sits size skew skid skim skin skip skis slab slam slap sled
slew slid slim slip slit slot slow slug smog smug snag snap snip snob snow snub
soak soap soar sobs sock soda sofa soft soil sold sole solo some song sons soon
soot sore sort soul soup sour sown soya spam span spar spas spat sped spin spit
spot spry spud spun spur stab stag star stay stem step stew stir stop stow stub
stud stun subs such suds sues suit sulk sumo sums sung sunk sure surf swab swam
swan swap swat sway swig swim sync tabs tack taco tact tags tail take tale talk
tall tame tang tank tape taps tarp tart task taut taxi teak teal team tear teas
tech teem teen tell tend tens tent term test text than that thaw them then they
thin this thou thud thug thus tick tide tidy tier ties tile till tilt time tint
tiny tips tire toad toes tofu toga toil told toll tomb tone tons took tool toot
tops tore torn toss tote tour tout town tows toys tram trap tray tree trek trim
trio trip trod trot true tuba tube tubs tuck tuft tugs tuna tune turf tusk tutu
twig twin twos type typo ugly undo unit unto upon urge urns used user uses vain
vale vane vans vary vase vast veal veer veil vein vent verb very vest veto vial
vibe vice view vile vine visa void volt vote vows wade wads waft wage wags waif
wail wait wake walk wall wand wane want ward ware warm warn warp wars wart wary
wash wasp watt wave wavy waxy ways weak wean wear webs weds weed week weep weld
well welt went wept were west wets what when whim whip whir whiz whom wick wide
wife wigs wild will wilt wimp wind wine wing wink wins wipe wire wise wish wisp
with wits woes woke wolf wood wool word wore work worm worn wove wrap wren writ
yams yank yard yarn yawn yeah year yell yelp yoga yogi yoke yolk yore your zaps
zeal zero zest zinc zone zoom
`;

export const DICT = [...new Set(RAW.trim().split(/\s+/))];

// Start/target pairs. par = length of the shortest solution in STEPS (edges),
// BFS-verified against the DICT above — if you edit DICT, re-verify these.
export const PUZZLES = [
  { start: "cold", target: "warm", par: 4 },
  { start: "east", target: "west", par: 3 },
  { start: "head", target: "tail", par: 5 },
  { start: "lead", target: "gold", par: 4 },
  { start: "hate", target: "love", par: 4 },
  { start: "work", target: "rest", par: 5 },
  { start: "fish", target: "bird", par: 6 },
  { start: "wine", target: "beer", par: 6 },
  { start: "book", target: "film", par: 6 },
  { start: "moon", target: "star", par: 6 },
  { start: "ship", target: "dock", par: 6 },
  { start: "cool", target: "warm", par: 5 },
  { start: "hand", target: "foot", par: 5 },
  { start: "mice", target: "rats", par: 4 },
  { start: "seed", target: "tree", par: 5 },
  { start: "salt", target: "corn", par: 5 },
  { start: "fire", target: "cold", par: 4 },
  { start: "slow", target: "fast", par: 6 },
  { start: "loss", target: "wins", par: 5 },
  { start: "sick", target: "well", par: 4 },
  { start: "boat", target: "dock", par: 5 },
  { start: "milk", target: "teas", par: 5 },
  { start: "pawn", target: "king", par: 5 },
  { start: "bike", target: "cars", par: 4 },
];
