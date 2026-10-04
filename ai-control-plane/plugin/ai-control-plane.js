/*****************************************************************************
 * OpenRCT2 AI Control Plane
 *
 * An intransient OpenRCT2 plugin that exposes the running game to local
 * tools (such as an AI agent via the bundled MCP bridge) over a localhost TCP
 * socket. Requests and responses are newline-delimited JSON:
 *
 *   -> {"id": 1, "method": "list_rides", "params": {}}
 *   <- {"id": 1, "result": [...]}
 *   <- {"id": 2, "error": {"message": "..."}}
 *
 * All world mutations go through built-in game actions, so they respect money,
 * land ownership, clearance checks and multiplayer synchronisation exactly as
 * if the player had performed them.
 *
 * Coordinate conventions used by every method (except execute_action, which
 * takes raw game action arguments):
 *   - x, y are TILE coordinates (world coordinate / 32).
 *   - z is a WORLD height (the same unit game actions use). One land step and
 *     one footpath slope rise is 16 z units.
 *   - direction 0..3 means: 0 = x-1, 1 = y+1, 2 = x+1, 3 = y-1.
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

'use strict';

(function () {
    const PLUGIN_NAME = 'AI Control Plane';
    const PLUGIN_VERSION = '1.0.0';
    const STORE_PREFIX = 'AIControlPlane.';
    const DEFAULT_PORT = 8765;

    // World constants (see src/openrct2/world/Footpath.h and Location.hpp)
    const TILE_SIZE = 32;
    const LAND_STEP = 16;
    const PATH_CLEARANCE = 32;
    const ENTRANCE_CLEARANCE = 56; // RideEntranceHeight
    const EXIT_CLEARANCE = 40; // RideExitHeight
    const FOOTPATH_MIN_Z = 2 * 8;
    const FOOTPATH_MAX_Z = 248 * 8;
    const DIR_DX = [-1, 0, 1, 0];
    const DIR_DY = [0, 1, 0, -1];

    const SURFACE_FLAG_EDITOR_ONLY = 1 << 2;
    const SURFACE_FLAG_QUEUE = 1 << 3;
    const PATH_CONSTRUCT_QUEUE = 1 << 0;
    const PATH_CONSTRUCT_LEGACY = 1 << 1;
    const COMMAND_FLAG_ALLOW_DURING_PAUSED = 1 << 3;

    const ENTRANCE_RIDE_ENTRANCE = 0;
    const ENTRANCE_RIDE_EXIT = 1;
    const ENTRANCE_PARK = 2;
    const ENTRANCE_TYPE_NAMES = ['ride_entrance', 'ride_exit', 'park_entrance'];

    const STATUS_NAMES = [
        'ok', 'invalidParameters', 'disallowed', 'gamePaused', 'insufficientFunds', 'notInEditorMode', 'notOwned',
        'tooLow', 'tooHigh', 'noClearance', 'itemAlreadyPlaced', 'notClosed', 'broken', 'noFreeElements',
    ];

    const MONTH_NAMES = ['March', 'April', 'May', 'June', 'July', 'August', 'September', 'October'];

    // Footpath placement on terrain, indexed by the surface's raised-corner mask.
    // Mirrors kDefaultPathSlope in src/openrct2/world/Footpath.cpp.
    const TERRAIN_PATH = [
        { t: 'flat' }, { t: 'irregular' }, { t: 'irregular' }, { t: 'sloped', d: 2 },
        { t: 'irregular' }, { t: 'irregular' }, { t: 'sloped', d: 3 }, { t: 'raise' },
        { t: 'irregular' }, { t: 'sloped', d: 1 }, { t: 'irregular' }, { t: 'raise' },
        { t: 'sloped', d: 0 }, { t: 'raise' }, { t: 'raise' }, { t: 'irregular' },
    ];

    const MAX_REGION_TILES = 128 * 128;
    const WRITE_CHUNK = 32 * 1024;
    const ACTION_TIMEOUT_MS = 15000;
    const SEARCH_SLICE = 2000;
    const HEURISTIC_WEIGHT = 1.4;
    const LOG_SIZE = 50;

    // <generated-ride-data> (tools/gen_ride_data.py; do not edit by hand)
    const RIDE_CATEGORIES = ["transport", "gentle", "rollercoaster", "thrill", "water", "shop"];
    const RTD_FLAGS = {
        hasTrackColourMain: 0,
        hasTrackColourAdditional: 1,
        hasTrackColourSupports: 2,
        hasSinglePieceStation: 3,
        hasLeaveWhenAnotherVehicleArrivesAtStation: 4,
        canSynchroniseWithAdjacentStations: 5,
        trackMustBeOnWater: 6,
        hasGForces: 7,
        cannotHaveGaps: 8,
        hasDataLogging: 9,
        hasDrops: 10,
        noTestMode: 11,
        hasCoveredPieces: 12,
        noVehicles: 13,
        hasLoadOptions: 14,
        hasLsmBehaviourOnFlat: 15,
        vehicleIsIntegral: 16,
        isShopOrFacility: 17,
        noWallsAroundTrack: 18,
        isFlatRide: 19,
        guestsWillRideAgain: 20,
        guestsShouldGoInsideFacility: 21,
        describeAsInside: 22,
        sellsFood: 23,
        sellsDrinks: 24,
        hasVehicleColours: 25,
        checkForStalling: 26,
        hasTrack: 27,
        allowExtraTowerBases: 28,
        layeredVehiclePreview: 29,
        supportsMultipleColourSchemes: 30,
        allowDoorsOnTrack: 31,
        hasMusicByDefault: 32,
        allowMusic: 33,
        hasInvertedVariant: 34,
        checkGForces: 35,
        hasEntranceAndExit: 36,
        allowMoreVehiclesThanStationFits: 37,
        hasAirTime: 38,
        singleSession: 39,
        allowMultipleCircuits: 40,
        allowCableLiftHill: 41,
        showInTrackDesigner: 42,
        isTransportRide: 43,
        interestingToLookAt: 44,
        slightlyInterestingToLookAt: 45,
        startConstructionInverted: 46,
        listVehiclesSeparately: 47,
        supportsLevelCrossings: 48,
        isSuspended: 49,
        hasLandscapeDoors: 50,
        upInclineRequiresLift: 51,
        guestsCanUseUmbrella: 52,
        hasOneStation: 53,
        hasSeatRotation: 54,
        allowReversedTrains: 55,
        requireExplicitListingInMusicObjects: 56,
        hasRoofOverWholeRide: 57,
        runningSpeedAffectsReliability: 58,
        poweredLaunchAffectsReliability: 59,
        reverseInclineLaunchAffectsReliability: 60,
        isDummyType: 61,
    };
    const TRACK_GROUPS = [
        "flat", "straight", "stationEnd", "liftHill", "liftHillSteep", "liftHillCurve",
        "flatRollBanking", "verticalLoop", "slope", "slopeSteepDown", "flatToSteepSlope", "slopeCurve",
        "slopeCurveSteep", "sBend", "curveVerySmall", "curveSmall", "curve", "curveLarge",
        "twist", "halfLoop", "corkscrew", "tower", "helixUpBankedHalf", "helixDownBankedHalf",
        "helixUpBankedQuarter", "helixDownBankedQuarter", "helixUpUnbankedQuarter", "helixDownUnbankedQuarter", "brakes", "onridePhoto",
        "waterSplash", "slopeVertical", "barrelRoll", "poweredLift", "halfLoopLarge", "slopeCurveBanked",
        "logFlumeReverser", "heartlineRoll", "reverser", "reverseFreefall", "slopeToFlat", "blockBrakes",
        "slopeRollBanking", "slopeSteepLong", "curveVertical", "liftHillCable", "liftHillCurved", "quarterLoop",
        "spinningTunnel", "booster", "inlineTwistUninverted", "inlineTwistInverted", "quarterLoopUninvertedUp", "quarterLoopUninvertedDown",
        "quarterLoopInvertedUp", "quarterLoopInvertedDown", "rapids", "flyingHalfLoopUninvertedUp", "flyingHalfLoopInvertedDown", "flatRideBase",
        "waterfall", "whirlpool", "brakeForDrop", "corkscrewUninverted", "corkscrewInverted", "heartlineTransfer",
        "miniGolfHole", "rotationControlToggle", "slopeSteepUp", "corkscrewLarge", "halfLoopMedium", "zeroGRoll",
        "zeroGRollLarge", "flyingLargeHalfLoopUninvertedUp", "flyingLargeHalfLoopInvertedDown", "flyingLargeHalfLoopUninvertedDown", "flyingLargeHalfLoopInvertedUp", "flyingHalfLoopUninvertedDown",
        "flyingHalfLoopInvertedUp", "slopeCurveLarge", "slopeCurveLargeBanked", "diagBrakes", "diagBlockBrakes", "inclinedBrakes",
        "diagBooster", "diagSlopeSteepLong", "diveLoop", "diagSlope", "diagSlopeSteepUp", "diagSlopeSteepDown",
    ];
    // Index = ride type id: [name, category, startPiece, flagsLow, flagsHigh, trackGroups, extraTrackGroups,
    //                       maxHeight, liftSpeedMin, liftSpeedMax, specialType, clearanceHeight, maxMass]
    const RIDE_TYPE_DATA = [
        ["spiral_rc",2,1,1309689527,5466,[1,2,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,41,42,46,68,87,88,89],[3,49],19,7,7,0,24,31],
        ["stand_up_rc",2,1,1309689527,8394074,[1,2,3,6,7,8,9,11,13,15,16,17,19,20,22,23,24,25,26,27,28,29,34,35,41,42,43,68,69,70,79,81,82,87,88,89],[10,12,31,32,44,47,71,72],25,4,6,0,24,18],
        ["suspended_swinging_rc",2,1,1309689527,136282,[1,2,3,8,9,11,13,15,16,17,26,27,28,41,68,87,88,89],[],24,4,6,0,40,26],
        ["inverted_rc",2,1,1309689527,8525146,[1,2,3,6,7,8,9,11,12,13,15,16,17,18,19,20,24,25,26,27,28,29,31,34,35,41,42,43,44,47,68,69,70,79,80,81,82,85,86,87,88,89],[10,32,49,71,72],42,5,7,0,40,27],
        ["junior_rc",2,1,3457173175,8394074,[1,2,3,5,6,8,10,11,13,15,16,17,22,23,28,41,49,81,82,87],[9,29,68,88,89],12,4,6,0,24,18],
        ["miniature_railway",0,1,1241530932,68914,[1,2,8,13,15,16,17,87],[],7,5,5,0,32,39],
        ["monorail",0,1,1241530935,3378,[1,2,8,13,15,16,17,87],[],8,5,5,0,32,78],
        ["mini_suspended_rc",2,1,1309689525,136282,[1,2,3,8,13,15,16,17,87],[],10,4,5,0,24,3],
        ["boat_hire",4,1,1308641349,18,[1,2,13,14,15,16,17],[],255,5,5,10,16,255],
        ["wooden_wild_mouse",2,1,3457173173,5210,[1,2,3,4,8,9,10,14,15,68],[],14,4,5,0,24,4],
        ["steeplechase",2,1,1309689527,5210,[1,2,3,8,13,15,16,17,26,27,28,41,81,82,87],[],14,4,5,0,24,4],
        ["car_ride",1,1,3390063143,9266,[1,2,8,14,15,48],[9,56,68],6,5,5,0,24,2],
        ["launched_freefall",3,66,1242841871,5138,[21],[],255,5,5,0,32,15],
        ["bobsleigh_rc",2,1,1309689527,5466,[1,2,3,6,8,13,15,16,22,23,28,29,41],[],19,4,5,0,24,25],
        ["observation_tower",1,66,1241792783,9234,[21],[],255,5,5,0,32,15],
        ["looping_rc",2,1,1309689527,142611802,[1,2,3,6,7,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,35,41,42,43,49,68,81,82,87,88,89],[10,18,19,20,31,32,34,44,47,69,70,71,72],35,4,6,0,24,18],
        ["dinghy_slide",4,1,1309693623,5202,[1,2,3,8,9,13,15,16,68],[],15,4,5,0,24,5],
        ["mine_train_rc",2,1,1309689527,8394074,[1,2,3,6,8,9,11,13,15,16,17,22,23,28,29,41,43,68,81,82,87,88,89],[],21,4,6,0,24,15],
        ["chairlift",0,1,1241530405,67251250,[1,2,8,14],[],40,5,5,0,32,18],
        ["corkscrew_rc",2,1,1309689527,8394074,[1,2,3,6,7,8,9,11,12,13,15,16,17,19,20,22,23,24,25,26,27,28,29,34,35,41,42,43,49,68,69,70,79,81,82,85,87,88,89],[10,18,31,32,44,47,71,72,86],28,4,6,0,24,18],
        ["maze",1,101,138684428,1048592,[],[],6,5,5,1,24,18],
        ["spiral_slide",1,258,796943,36882,[],[],15,5,5,3,128,255],
        ["go_karts",3,1,1242826757,2101266,[1,2,8,11,13,14,15,16,17,79,87],[9,43,68,88,89],8,5,5,0,24,255],
        ["log_flume",4,1,1242580535,5234,[1,2,8,9,13,15,29,36],[],10,5,5,0,24,255],
        ["river_rapids",4,1,1242842677,5234,[1,2,8,14,29,56,60,61],[],9,5,5,0,32,255],
        ["dodgems",1,259,34343183,33562643,[],[],9,5,5,0,48,255],
        ["swinging_ship",3,261,34423053,37010,[],[],12,5,5,0,112,255],
        ["swinging_inverter_ship",3,263,34423055,37010,[],[],15,5,5,0,176,255],
        ["food_stall",5,262,9316617,32768,[],[],12,5,5,0,64,255],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["drink_stall",5,262,17705225,32768,[],[],12,5,5,0,64,255],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["shop",5,262,928009,32768,[],[],12,5,5,0,64,255],
        ["merry_go_round",1,266,34423048,16814227,[],[],12,5,5,0,64,255],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["information_kiosk",5,264,928009,32768,[],[],12,5,5,0,48,255],
        ["toilets",5,262,7219464,32768,[],[],12,5,5,4,32,255],
        ["ferris_wheel",1,265,34406665,41106,[],[],16,5,5,0,176,255],
        ["motion_simulator",3,258,34423048,41106,[],[],12,5,5,8,64,255],
        ["3d_cinema",3,266,38617352,32914,[],[],12,5,5,0,128,255],
        ["top_spin",3,266,34423055,37010,[],[],16,5,5,0,112,255],
        ["space_rings",1,266,34343176,41106,[],[],16,5,5,9,48,255],
        ["reverse_freefall_rc",2,1,1309722279,8393810,[1,2,4,29,39],[],255,5,5,0,32,255],
        ["lift",0,66,1510228237,3090,[21],[],255,5,5,0,32,15],
        ["vertical_drop_rc",2,1,1309689527,5210,[0,1,2,3,4,6,7,8,9,10,11,12,13,15,16,17,20,22,23,24,25,26,27,28,29,31,34,35,41,42,44,62,68,69,70,71,72,79,81,82,86,87,88,89],[18,19,32,33,34,43,47,49,85],55,4,5,0,24,25],
        ["cash_machine",5,262,928008,32768,[],[],12,5,5,5,64,255],
        ["twist",3,266,34423048,37010,[],[],12,5,5,0,64,255],
        ["haunted_house",1,266,5062920,32914,[],[],16,5,5,0,160,255],
        ["first_aid",5,262,7219464,32768,[],[],12,5,5,6,48,255],
        ["circus",1,266,38617352,32913,[],[],12,5,5,0,128,255],
        ["ghost_train",1,1,3390064295,267378,[1,2,8,14,15,28,48],[],8,5,5,0,24,2],
        ["twister_rc",2,1,1309689527,8394074,[0,1,2,3,6,7,8,9,11,12,13,15,16,17,18,19,20,22,23,24,25,26,27,28,29,31,32,33,34,35,41,42,43,44,47,49,68,69,70,71,72,79,81,82,85,86,87,88,89],[4,10,62],40,5,8,0,24,31],
        ["wooden_rc",2,1,1309689527,8394074,[0,1,2,3,6,7,8,9,11,12,13,15,16,17,22,23,28,29,30,34,35,41,42,43,68,70,81,82,87,88,89],[49],41,5,7,0,24,19],
        ["side_friction_rc",2,1,1309689527,8394074,[1,2,3,8,9,13,15,16,17,28,68,87,88,89],[],18,3,5,0,24,15],
        ["steel_wild_mouse",2,1,3457173175,5210,[1,2,3,4,8,9,10,11,14,15,28,41,68],[67],16,4,6,0,24,4],
        ["multi_dimension_rc",2,1,1309689527,12588382,[1,2,3,6,8,9,13,15,16,17,22,23,24,25,26,27,28,29,31,41,50,52,53,68,81,82,87,88,89],[],40,4,6,0,24,78],
        ["multi_dimension_rc_alt",255,1,1309689527,541069314,[],[],40,4,6,0,24,78],
        ["flying_rc",2,1,1309689527,21854,[1,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,31,35,41,42,50,52,57,68,73,79,81,82,87,88,89],[2,7,10,33,43,49,75,77,85],30,4,6,0,24,35],
        ["flying_rc_alt",255,1,1309689527,536891394,[],[],30,4,6,0,24,35],
        ["virginia_reel",2,1,1309689527,5210,[1,2,3,8,14,15],[],14,3,5,0,24,15],
        ["splash_boats",4,1,1242580535,9330,[1,2,8,9,13,16,29],[],16,5,5,0,24,255],
        ["mini_helicopters",1,1,3390063143,9266,[1,2,8,14,15],[48],7,5,5,0,24,2],
        ["lay_down_rc",2,1,1309689527,5470,[1,2,3,6,7,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,35,41,42,43,50,57,63,68,79,81,82,85,87,88,89],[10,49,77],26,4,6,0,24,25],
        ["suspended_monorail",0,1,1241530935,134450,[1,2,8,13,15,16,17,87],[],12,5,5,0,40,78],
        ["lay_down_rc_alt",255,1,1309689527,536875010,[],[],26,4,6,0,24,25],
        ["reverser_rc",2,1,1846560439,5210,[1,2,3,8,13,15,16,28,38],[],18,3,5,0,24,15],
        ["heartline_twister_rc",2,1,1309689527,8393818,[1,2,3,4,8,9,37,65,68],[],22,4,6,0,24,18],
        ["mini_golf",1,1,1207961607,2105362,[1,2,8,14,66],[],7,5,5,2,32,255],
        ["giga_rc",2,1,1309689527,8394586,[1,2,3,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,31,35,41,42,43,44,45,68,79,81,82,85,87,88,89],[7,10,19,20,32,33,34,47,49,69,70,71,72,84,86],86,5,8,0,24,31],
        ["roto_drop",3,66,1242841871,5266,[21],[],255,5,5,0,32,15],
        ["flying_saucers",1,259,34343179,4243,[],[],9,5,5,0,48,255],
        ["crooked_house",1,266,5062920,32914,[],[],16,5,5,0,96,255],
        ["monorail_cycles",1,1,1242581543,8210,[1,2,13,15,16],[],5,5,5,0,24,2],
        ["compact_inverted_rc",2,1,1309689527,268571994,[1,2,3,6,7,8,9,11,12,13,15,16,17,18,19,20,24,25,28,29,31,41,68,81,82,87,88,89],[],27,4,6,0,40,18],
        ["water_coaster",2,1,1309693623,5210,[1,2,3,6,8,9,11,13,15,16,17,22,23,28,29,41,49,68,81,82,87,88,89],[10],18,4,6,0,24,13],
        ["air_powered_vertical_rc",2,1,1309689511,5210,[1,2,4,5,6,16,28,29,39,40],[49],255,5,5,0,32,255],
        ["inverted_hairpin_rc",2,1,1309689527,136282,[1,2,3,4,8,9,10,11,14,15,28,41,68],[],16,4,6,0,24,4],
        ["magic_carpet",3,257,34423055,37010,[],[],15,5,5,0,176,255],
        ["submarine_ride",4,1,1242579031,58,[1,2,14,15],[],255,5,5,0,16,255],
        ["river_rafts",4,1,1242579511,9266,[1,2,13,16],[8,9,29],12,5,5,0,24,255],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["enterprise",3,259,35471624,37010,[],[],16,5,5,7,160,255],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["inverted_impulse_rc",2,1,1309689527,8525146,[1,2,8,9,31,44,68],[],45,4,7,0,40,23],
        ["mini_rc",2,1,1309689527,8394074,[1,2,3,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,41,42,68,87,88,89],[46,49],16,4,6,0,24,10],
        ["mine_ride",2,1,1309689527,8394074,[1,2,6,8,13,15,16,17,22,23,24,25,26,27,29,87],[],13,5,5,0,24,27],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0,64,255],
        ["lim_launched_rc",2,1,1309689527,8394074,[1,2,6,7,8,9,11,12,13,15,16,17,18,19,20,22,23,24,25,26,27,28,29,31,32,34,35,41,42,43,44,47,68,69,70,71,72,87,88,89],[10],35,4,6,0,24,18],
        ["hypercoaster",2,1,1309689527,8394074,[1,2,3,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,35,41,42,43,68,79,81,82,85,87,88,89],[7,10,18,19,20,31,32,34,44,47,49,69,70,71,72,86],55,4,6,0,24,18],
        ["hyper_twister",2,1,1309689527,8394074,[0,1,2,3,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,31,35,41,42,43,44,68,79,81,82,85,87,88,89],[4,7,10,18,19,20,32,33,34,47,49,62,69,70,71,72,86],61,5,8,0,24,31],
        ["monster_trucks",1,1,1242579495,9266,[1,2,8,9,14,15,56,68],[48],18,5,5,0,24,2],
        ["spinning_wild_mouse",2,1,1309689527,5210,[1,2,3,8,10,14,15,28,41,67],[4,9,11,68],16,4,6,0,24,4],
        ["classic_mini_rc",2,1,3457173175,8394074,[1,2,3,5,6,8,9,10,11,13,15,16,17,22,23,28,41,49,68,81,82,87,88,89],[29],15,4,6,0,24,18],
        ["hybrid_rc",2,1,1309689525,8394074,[0,1,2,3,4,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,31,32,33,35,41,42,43,44,47,68,71,72,79,81,82,83,87,88,89],[49],43,5,11,0,24,18],
        ["single_rail_rc",2,1,1309689527,8394074,[0,1,2,3,4,6,8,9,10,11,12,13,15,16,17,19,20,22,23,24,25,26,27,28,29,31,32,34,35,41,42,44,47,68,69,70,71,72,79,81,82,83,86,87,88,89],[43,85],28,5,8,0,24,18],
        ["alpine_rc",2,1,1309691429,528434,[0,1,2,3,6,8,10,11,13,15,16,17,23,25,27,87],[22,24,26],18,4,5,0,24,4],
        ["classic_wooden_rc",2,1,1309689527,8394074,[0,1,2,3,6,7,8,9,11,13,15,16,17,28,29,30,34,41,43,68,70,81,82,87,88,89],[12,49],24,3,5,0,24,19],
        ["classic_stand_up_rc",2,1,1309689527,8394074,[1,2,3,6,7,8,9,11,13,15,16,17,19,20,26,27,28,29,34,41,43,68,69,70,79,81,82,87,88,89],[10,12,31,32,44,47,71,72],30,4,6,0,24,18],
        ["lsm_rc",2,1,1309689527,8394586,[1,2,6,7,8,9,11,12,13,15,16,17,19,20,22,23,24,25,26,27,28,29,31,32,33,34,35,41,42,43,44,47,49,68,69,70,71,72,79,80,81,82,84,85,86,87,88,89],[3,10,45],33,5,5,0,24,31],
        ["classic_wooden_twister_rc",2,1,1309689527,8394074,[0,1,2,3,6,8,9,11,12,13,15,16,17,22,23,28,29,35,41,43,68,81,82,87,88,89],[7,30,34,49,70],24,3,5,0,24,19],
    ];
    // Index = track type (TrackElemType) id
    const TRACK_TYPE_NAMES = [
        "flat", "endStation", "beginStation", "middleStation", "up25", "up60",
        "flatToUp25", "up25ToUp60", "up60ToUp25", "up25ToFlat", "down25", "down60",
        "flatToDown25", "down25ToDown60", "down60ToDown25", "down25ToFlat", "leftQuarterTurn5Tiles", "rightQuarterTurn5Tiles",
        "flatToLeftBank", "flatToRightBank", "leftBankToFlat", "rightBankToFlat", "bankedLeftQuarterTurn5Tiles", "bankedRightQuarterTurn5Tiles",
        "leftBankToUp25", "rightBankToUp25", "up25ToLeftBank", "up25ToRightBank", "leftBankToDown25", "rightBankToDown25",
        "down25ToLeftBank", "down25ToRightBank", "leftBank", "rightBank", "leftQuarterTurn5TilesUp25", "rightQuarterTurn5TilesUp25",
        "leftQuarterTurn5TilesDown25", "rightQuarterTurn5TilesDown25", "sBendLeft", "sBendRight", "leftVerticalLoop", "rightVerticalLoop",
        "leftQuarterTurn3Tiles", "rightQuarterTurn3Tiles", "leftBankedQuarterTurn3Tiles", "rightBankedQuarterTurn3Tiles", "leftQuarterTurn3TilesUp25", "rightQuarterTurn3TilesUp25",
        "leftQuarterTurn3TilesDown25", "rightQuarterTurn3TilesDown25", "leftQuarterTurn1Tile", "rightQuarterTurn1Tile", "leftTwistDownToUp", "rightTwistDownToUp",
        "leftTwistUpToDown", "rightTwistUpToDown", "halfLoopUp", "halfLoopDown", "leftCorkscrewUp", "rightCorkscrewUp",
        "leftCorkscrewDown", "rightCorkscrewDown", "flatToUp60", "up60ToFlat", "flatToDown60", "down60ToFlat",
        "towerBase", "towerSection", "flatCovered", "up25Covered", "up60Covered", "flatToUp25Covered",
        "up25ToUp60Covered", "up60ToUp25Covered", "up25ToFlatCovered", "down25Covered", "down60Covered", "flatToDown25Covered",
        "down25ToDown60Covered", "down60ToDown25Covered", "down25ToFlatCovered", "leftQuarterTurn5TilesCovered", "rightQuarterTurn5TilesCovered", "sBendLeftCovered",
        "sBendRightCovered", "leftQuarterTurn3TilesCovered", "rightQuarterTurn3TilesCovered", "leftHalfBankedHelixUpSmall", "rightHalfBankedHelixUpSmall", "leftHalfBankedHelixDownSmall",
        "rightHalfBankedHelixDownSmall", "leftHalfBankedHelixUpLarge", "rightHalfBankedHelixUpLarge", "leftHalfBankedHelixDownLarge", "rightHalfBankedHelixDownLarge", "leftQuarterTurn1TileUp60",
        "rightQuarterTurn1TileUp60", "leftQuarterTurn1TileDown60", "rightQuarterTurn1TileDown60", "brakes", "booster", "maze",
        "leftQuarterBankedHelixLargeUp", "rightQuarterBankedHelixLargeUp", "leftQuarterBankedHelixLargeDown", "rightQuarterBankedHelixLargeDown", "leftQuarterHelixLargeUp", "rightQuarterHelixLargeUp",
        "leftQuarterHelixLargeDown", "rightQuarterHelixLargeDown", "up25LeftBanked", "up25RightBanked", "waterfall", "rapids",
        "onRidePhoto", "down25LeftBanked", "down25RightBanked", "waterSplash", "flatToUp60LongBase", "up60ToFlatLongBase",
        "whirlpool", "down60ToFlatLongBase", "flatToDown60LongBase", "cableLiftHill", "reverseFreefallSlope", "reverseFreefallVertical",
        "up90", "down90", "up60ToUp90", "down90ToDown60", "up90ToUp60", "down60ToDown90",
        "brakeForDrop", "leftEighthToDiag", "rightEighthToDiag", "leftEighthToOrthogonal", "rightEighthToOrthogonal", "leftEighthBankToDiag",
        "rightEighthBankToDiag", "leftEighthBankToOrthogonal", "rightEighthBankToOrthogonal", "diagFlat", "diagUp25", "diagUp60",
        "diagFlatToUp25", "diagUp25ToUp60", "diagUp60ToUp25", "diagUp25ToFlat", "diagDown25", "diagDown60",
        "diagFlatToDown25", "diagDown25ToDown60", "diagDown60ToDown25", "diagDown25ToFlat", "diagFlatToUp60", "diagUp60ToFlat",
        "diagFlatToDown60", "diagDown60ToFlat", "diagFlatToLeftBank", "diagFlatToRightBank", "diagLeftBankToFlat", "diagRightBankToFlat",
        "diagLeftBankToUp25", "diagRightBankToUp25", "diagUp25ToLeftBank", "diagUp25ToRightBank", "diagLeftBankToDown25", "diagRightBankToDown25",
        "diagDown25ToLeftBank", "diagDown25ToRightBank", "diagLeftBank", "diagRightBank", "logFlumeReverser", "spinningTunnel",
        "leftBarrelRollUpToDown", "rightBarrelRollUpToDown", "leftBarrelRollDownToUp", "rightBarrelRollDownToUp", "leftBankToLeftQuarterTurn3TilesUp25", "rightBankToRightQuarterTurn3TilesUp25",
        "leftQuarterTurn3TilesDown25ToLeftBank", "rightQuarterTurn3TilesDown25ToRightBank", "poweredLift", "leftLargeHalfLoopUp", "rightLargeHalfLoopUp", "leftLargeHalfLoopDown",
        "rightLargeHalfLoopDown", "leftFlyerTwistUp", "rightFlyerTwistUp", "leftFlyerTwistDown", "rightFlyerTwistDown", "flyerHalfLoopUninvertedUp",
        "flyerHalfLoopInvertedDown", "leftFlyerCorkscrewUp", "rightFlyerCorkscrewUp", "leftFlyerCorkscrewDown", "rightFlyerCorkscrewDown", "heartLineTransferUp",
        "heartLineTransferDown", "leftHeartLineRoll", "rightHeartLineRoll", "minigolfHoleA", "minigolfHoleB", "minigolfHoleC",
        "minigolfHoleD", "minigolfHoleE", "multiDimInvertedFlatToDown90QuarterLoop", "up90ToInvertedFlatQuarterLoop", "invertedFlatToDown90QuarterLoop", "leftCurvedLiftHill",
        "rightCurvedLiftHill", "leftReverser", "rightReverser", "airThrustTopCap", "airThrustVerticalDown", "airThrustVerticalDownToLevel",
        "blockBrakes", "leftBankedQuarterTurn3TileUp25", "rightBankedQuarterTurn3TileUp25", "leftBankedQuarterTurn3TileDown25", "rightBankedQuarterTurn3TileDown25", "leftBankedQuarterTurn5TileUp25",
        "rightBankedQuarterTurn5TileUp25", "leftBankedQuarterTurn5TileDown25", "rightBankedQuarterTurn5TileDown25", "up25ToLeftBankedUp25", "up25ToRightBankedUp25", "leftBankedUp25ToUp25",
        "rightBankedUp25ToUp25", "down25ToLeftBankedDown25", "down25ToRightBankedDown25", "leftBankedDown25ToDown25", "rightBankedDown25ToDown25", "leftBankedFlatToLeftBankedUp25",
        "rightBankedFlatToRightBankedUp25", "leftBankedUp25ToLeftBankedFlat", "rightBankedUp25ToRightBankedFlat", "leftBankedFlatToLeftBankedDown25", "rightBankedFlatToRightBankedDown25", "leftBankedDown25ToLeftBankedFlat",
        "rightBankedDown25ToRightBankedFlat", "flatToLeftBankedUp25", "flatToRightBankedUp25", "leftBankedUp25ToFlat", "rightBankedUp25ToFlat", "flatToLeftBankedDown25",
        "flatToRightBankedDown25", "leftBankedDown25ToFlat", "rightBankedDown25ToFlat", "leftQuarterTurn1TileUp90", "rightQuarterTurn1TileUp90", "leftQuarterTurn1TileDown90",
        "rightQuarterTurn1TileDown90", "multiDimUp90ToInvertedFlatQuarterLoop", "multiDimFlatToDown90QuarterLoop", "multiDimInvertedUp90ToFlatQuarterLoop", "rotationControlToggle", "flatTrack1x4A",
        "flatTrack2x2", "flatTrack4x4", "flatTrack2x4", "flatTrack1x5", "flatTrack1x1A", "flatTrack1x4B",
        "flatTrack1x1B", "flatTrack1x4C", "flatTrack3x3", "leftLargeCorkscrewUp", "rightLargeCorkscrewUp", "leftLargeCorkscrewDown",
        "rightLargeCorkscrewDown", "leftMediumHalfLoopUp", "rightMediumHalfLoopUp", "leftMediumHalfLoopDown", "rightMediumHalfLoopDown", "leftZeroGRollUp",
        "rightZeroGRollUp", "leftZeroGRollDown", "rightZeroGRollDown", "leftLargeZeroGRollUp", "rightLargeZeroGRollUp", "leftLargeZeroGRollDown",
        "rightLargeZeroGRollDown", "leftFlyerLargeHalfLoopUninvertedUp", "rightFlyerLargeHalfLoopUninvertedUp", "leftFlyerLargeHalfLoopInvertedDown", "rightFlyerLargeHalfLoopInvertedDown", "leftFlyerLargeHalfLoopInvertedUp",
        "rightFlyerLargeHalfLoopInvertedUp", "leftFlyerLargeHalfLoopUninvertedDown", "rightFlyerLargeHalfLoopUninvertedDown", "flyerHalfLoopInvertedUp", "flyerHalfLoopUninvertedDown", "leftEighthToDiagUp25",
        "rightEighthToDiagUp25", "leftEighthToDiagDown25", "rightEighthToDiagDown25", "leftEighthToOrthogonalUp25", "rightEighthToOrthogonalUp25", "leftEighthToOrthogonalDown25",
        "rightEighthToOrthogonalDown25", "diagUp25ToLeftBankedUp25", "diagUp25ToRightBankedUp25", "diagLeftBankedUp25ToUp25", "diagRightBankedUp25ToUp25", "diagDown25ToLeftBankedDown25",
        "diagDown25ToRightBankedDown25", "diagLeftBankedDown25ToDown25", "diagRightBankedDown25ToDown25", "diagLeftBankedFlatToLeftBankedUp25", "diagRightBankedFlatToRightBankedUp25", "diagLeftBankedUp25ToLeftBankedFlat",
        "diagRightBankedUp25ToRightBankedFlat", "diagLeftBankedFlatToLeftBankedDown25", "diagRightBankedFlatToRightBankedDown25", "diagLeftBankedDown25ToLeftBankedFlat", "diagRightBankedDown25ToRightBankedFlat", "diagFlatToLeftBankedUp25",
        "diagFlatToRightBankedUp25", "diagLeftBankedUp25ToFlat", "diagRightBankedUp25ToFlat", "diagFlatToLeftBankedDown25", "diagFlatToRightBankedDown25", "diagLeftBankedDown25ToFlat",
        "diagRightBankedDown25ToFlat", "diagUp25LeftBanked", "diagUp25RightBanked", "diagDown25LeftBanked", "diagDown25RightBanked", "leftEighthBankToDiagUp25",
        "rightEighthBankToDiagUp25", "leftEighthBankToDiagDown25", "rightEighthBankToDiagDown25", "leftEighthBankToOrthogonalUp25", "rightEighthBankToOrthogonalUp25", "leftEighthBankToOrthogonalDown25",
        "rightEighthBankToOrthogonalDown25", "diagBrakes", "diagBlockBrakes", "down25Brakes", "diagBooster", "diagFlatToUp60LongBase",
        "diagUp60ToFlatLongBase", "diagFlatToDown60LongBase", "diagDown60ToFlatLongBase", "leftEighthDiveLoopUpToOrthogonal", "rightEighthDiveLoopUpToOrthogonal", "leftEighthDiveLoopDownToDiag",
        "rightEighthDiveLoopDownToDiag", "diagDown25Brakes",
    ];
    // Track type -> per-sequence flags (bits 0-3: entrance connection sides, bit 4: origin, bit 5: connects to path)
    const TRACK_SEQUENCE_FLAGS = {1:[218],2:[218],3:[218],66:[16,137,1,131,8,2,140,134,4],101:[31],257:[154,0,138,0],258:[153,131,140,134],259:[153,1,1,131,8,0,0,2,8,0,0,2,140,4,4,134],260:[153,1,1,131,140,4,4,134],261:[26,0,138,138,0],262:[177],263:[146,0,130,0],264:[191],265:[26,139,10,142],266:[16,137,1,131,8,2,140,134,4]};
    // Index = ride type id: rating requirements { name: threshold } and whether inversions relax drop height,
    // drop count and negative G requirements (RideRatings.cpp). Missing one divides the ride's ratings.
    const RIDE_REQUIREMENTS = [
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:50},
        {requirementDropHeight:8,requirementMaxSpeed:786432,requirementNegativeGs:60,requirementLateralGs:150,requirementLength:24248320},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:30,relaxIfInversions:1},
        {requirementDropHeight:6,requirementMaxSpeed:458752,requirementNumDrops:1},
        {requirementLength:13107200,requirementUnsheltered:4},
        {requirementLength:11141120,requirementUnsheltered:4},
        {requirementDropHeight:6,requirementMaxSpeed:524288,requirementLateralGs:130,requirementLength:13107200},
        {},
        {requirementDropHeight:8,requirementMaxSpeed:458752,requirementNegativeGs:10,requirementLateralGs:150,requirementLength:11141120,requirementNumDrops:3},
        {requirementDropHeight:4,requirementMaxSpeed:524288,requirementNegativeGs:50,requirementLength:15728640,requirementNumDrops:2},
        {requirementLength:13107200},
        {},
        {requirementMaxSpeed:786432,requirementLateralGs:120,requirementLength:24248320},
        {requirementUnsheltered:5},
        {requirementDropHeight:14,requirementMaxSpeed:655360,requirementNegativeGs:10,requirementNumDrops:2,relaxIfInversions:1},
        {requirementDropHeight:12,requirementMaxSpeed:458752,requirementLength:9175040},
        {requirementDropHeight:8,requirementMaxSpeed:655360,requirementNegativeGs:10,requirementLength:24248320,requirementNumDrops:2},
        {requirementLength:9830400,requirementStations:1,requirementUnsheltered:4},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {},
        {},
        {requirementUnsheltered:6},
        {requirementDropHeight:6},
        {requirementDropHeight:2,requirementLength:13107200},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {requirementDropHeight:34},
        {requirementUnsheltered:5},
        {requirementDropHeight:20,requirementMaxSpeed:655360,requirementNegativeGs:10,requirementNumDrops:1},
        {},
        {},
        {},
        {},
        {},
        {requirementLength:11796480},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:10,requirementLength:24248320,requirementNumDrops:2},
        {requirementDropHeight:6,requirementMaxSpeed:327680,requirementLength:16384000,requirementNumDrops:2},
        {requirementDropHeight:6,requirementMaxSpeed:458752,requirementLateralGs:150,requirementLength:11141120,requirementNumDrops:2},
        {requirementInversions:1,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementInversions:1,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementInversions:1,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementInversions:1,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementLength:13762560,requirementNumDrops:2},
        {requirementDropHeight:6},
        {requirementLength:10485760},
        {requirementInversions:1,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementLength:11141120,requirementUnsheltered:4},
        {requirementInversions:1,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementReversals:1,requirementLength:13107200,requirementNumDrops:2},
        {requirementInversions:1,requirementNumDrops:1},
        {requirementHoles:1},
        {requirementDropHeight:16,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2},
        {},
        {},
        {},
        {requirementLength:9175040},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:30,relaxIfInversions:1},
        {requirementDropHeight:8,requirementMaxSpeed:458752,requirementNumDrops:1,requirementSplashdown:0},
        {requirementDropHeight:34},
        {requirementDropHeight:8,requirementMaxSpeed:458752,requirementNegativeGs:10,requirementLateralGs:150,requirementLength:11141120,requirementNumDrops:3},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {requirementDropHeight:20,requirementMaxSpeed:655360},
        {requirementDropHeight:12,requirementMaxSpeed:458752,requirementNegativeGs:50,requirementNumDrops:2},
        {requirementLength:17694720},
        {},
        {requirementDropHeight:10,requirementMaxSpeed:655360,requirementNegativeGs:10,requirementNumDrops:2,relaxIfInversions:1},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2,relaxIfInversions:1},
        {requirementLength:13107200},
        {requirementDropHeight:6,requirementMaxSpeed:458752,requirementLateralGs:150,requirementLength:11141120,requirementNumDrops:2},
        {requirementDropHeight:6,requirementMaxSpeed:458752,requirementNumDrops:2},
        {requirementDropHeight:14,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2},
        {requirementDropHeight:14,requirementMaxSpeed:655360,requirementNegativeGs:40,requirementNumDrops:2},
        {requirementMaxSpeed:327680,requirementLength:24248320},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:10,requirementLength:24248320,requirementNumDrops:2},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:50},
        {requirementDropHeight:10,requirementMaxSpeed:655360,requirementNegativeGs:10,requirementNumDrops:2},
        {requirementDropHeight:12,requirementMaxSpeed:655360,requirementNegativeGs:10,requirementLength:24248320,requirementNumDrops:2},
    ];
    // Track type -> clearance of each block above its base z, before the ride's own clearance (+256: vertical block)
    const TRACK_BLOCK_CLEARANCE = [
        [0],[0],[0],[0],[16],[64],[8],[32],[32],[8],[16],[64],
        [8],[32],[32],[8],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0],[0],[0],[0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],
        [8],[8],[8],[8],[8],[8],[8],[8],[0],[0],[16,0,16,16,0,16,16],[16,0,16,16,0,16,16],
        [16,0,16,16,0,16,16],[16,0,16,16,0,16,16],[0,0,0,0],[0,0,0,0],[16,16,96,16,0,0,16,96,16,16],[16,16,96,16,0,0,16,96,16,16],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[16,0,0,16],[16,0,0,16],
        [16,0,0,16],[16,0,0,16],[0],[0],[0,16,0],[0,16,0],[0,16,0],[0,16,0],[16,16,96,16],[16,96,16,16],[16,32,16],[16,32,16],
        [16,32,16],[16,32,16],[24],[24],[24],[24],[64,0,0,0,0,0,0,0,0],[0,0],[0],[16],[64],[8],
        [32],[32],[8],[16],[64],[8],[32],[32],[8],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0],
        [0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,4,4,0,0,4,4],[0,0,4,4,0,0,4,4],[4,4,0,0,4,4,0,0],[4,4,0,0,4,4,0,0],[0,0,0,0,4,4,4,0,0,0,0,4,4,4],[0,0,0,0,4,4,4,0,0,0,0,4,4,4],[4,4,4,0,0,0,0,4,4,4,0,0,0,0],[4,4,4,0,0,0,0,4,4,4,0,0,0,0],[64],
        [64],[64],[64],[0],[0],[0],[8,8,8,16,16,16,16],[8,8,8,16,16,16,16],[16,16,16,16,8,8,8],[16,16,16,16,8,8,8],[8,8,8,16,16,16,16],[8,8,8,16,16,16,16],
        [16,16,16,16,8,8,8],[16,16,16,16,8,8,8],[16],[16],[16],[0],[16],[16],[16],[16,16,16,16,16],[8,16,24,48],[48,48,24,8],
        [0],[48,24,16,8],[8,24,48,48],[8,8,32,64],[16,32,48,80,160,208,208],[48,48],[264,256],[264,256],[288,256],[288],[312],[312,256],
        [24],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0],[16,16,16,16],[64,64,64,64],
        [8,8,8,8],[32,32,32,32],[32,32,32,32],[8,8,8,8],[16,16,16,16],[64,64,64,64],[8,8,8,8],[32,32,32,32],[32,32,32,32],[8,8,8,8],[24,24,24,24],[24,24,24,24],
        [24,24,24,24],[24,24,24,24],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],
        [8,8,8,8],[8,8,8,8],[0,0,0,0],[0,0,0,0],[0],[0],[0,16,16],[0,16,16],[16,16,0],[16,16,0],[0,16,16,16],[16,16,16,16],
        [16,16,16,0],[16,16,16,0],[16],[24,40,56,192,96,192,16],[24,40,56,192,96,192,16],[16,192,96,192,56,40,24],[16,192,96,192,56,40,24],[0,16,16],[0,16,16],[16,16,0],[16,16,0],[16,16,96,16],
        [16,96,16,16],[16,32,16],[16,32,16],[16,32,16],[16,32,16],[0,32,0,0],[0,32,0,0],[0,0,0,0,0,0],[0,0,0,0,0,0],[0,0],[0,0],[0,0],
        [0,0,0],[0,0,0],[272,288,312,256],[312,288,272],[272,288,312,256],[0,0,8,8],[0,0,8,8],[0,0,0,0,0,0],[0,0,0,0,0,0],[32,32,32,32],[48,48],[208,208,160,80,48,32,16],
        [0],[16,0,0,16],[16,0,0,16],[16,0,0,16],[16,0,0,16],[16,0,16,16,0,16,16],[16,0,16,16,0,16,16],[16,0,16,16,0,16,16],[16,0,16,16,0,16,16],[16],[16],[16],
        [16],[16],[16],[16],[16],[8],[8],[8],[8],[8],[8],[8],
        [8],[8],[8],[8],[8],[8],[8],[8],[8],[328,256],[328,256],[328,256],
        [328,256],[312,288,272],[272,288,312,256],[312,288,272],[0],[0,0,0,0],[0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0],[0],[0,0,0,0],
        [0],[0,0,0,0],[0,0,0,0,0,0,0,0,0],[16,32,24,24,40,24],[16,32,24,24,40,24],[24,40,24,24,32,16],[24,40,24,24,32,16],[24,48,120,120,24],[24,48,120,120,24],[24,120,120,48,24],[24,120,120,48,24],[16,24,16],
        [16,24,16],[16,24,16],[16,24,16],[64,48,40,16],[64,48,40,16],[16,40,48,64],[16,40,48,64],[24,40,56,192,96,192,16],[24,40,56,192,96,192,16],[16,192,96,192,56,40,24],[16,192,96,192,56,40,24],[24,40,56,192,96,192,32],
        [24,40,56,192,96,192,32],[32,192,96,192,56,40,24],[32,192,96,192,56,40,24],[16,16,96,32],[32,96,16,16],[16,32,16,16,24],[16,32,16,16,24],[16,16,16,16,16],[16,16,16,16,16],[16,16,16,16,16],[16,16,16,16,16],[24,16,16,32,16],
        [24,16,16,32,16],[16,16,16,16],[16,16,16,16],[16,16,16,16],[16,16,16,16],[16,16,16,16],[16,16,16,16],[16,16,16,16],[16,16,16,16],[8,8,8,8],[8,8,8,8],[8,8,8,8],
        [8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],[8,8,8,8],
        [8,8,8,8],[16,16,16,16],[16,16,16,16],[16,16,16,16],[16,16,16,16],[16,32,16,16,24],[16,32,16,16,24],[16,16,16,16,16],[16,16,16,16,16],[16,16,16,16,16],[16,16,16,16,16],[24,16,16,32,16],
        [24,16,16,32,16],[0,0,0,0],[0,0,0,0],[16],[0,0,0,0],[0,16,16,32,40,40,64,88,88,104],[64,72,72,80,32,32,8,8,8,8],[8,8,8,8,32,32,80,72,72,64],[104,88,88,64,40,40,32,16,16,0],[64,88,88,80,48,24],[64,88,88,80,48,24],[24,48,80,88,88,64],
        [24,48,80,88,88,64],[16,16,16,16],
    ];
    // Track type -> [sharpest crest |vertical factor| (negative G), sharpest |lateral factor|], 0 = none
    // (Vehicle::GetGForces: G (hundredths) = speed * 980 / factor, speed in the game's unit).
    const TRACK_G_FACTORS = [
        [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[82,0],[103,0],[0,0],[0,0],
        [103,0],[82,0],[0,0],[0,0],[0,98],[0,98],[0,0],[0,0],[0,0],[0,0],[0,160],[0,160],
        [0,0],[0,0],[103,0],[103,0],[103,0],[103,0],[0,0],[0,0],[0,0],[0,0],[0,98],[0,98],
        [0,98],[0,98],[0,98],[0,98],[0,0],[0,0],[0,59],[0,59],[0,100],[0,100],[0,59],[0,59],
        [0,59],[0,59],[0,45],[0,45],[0,98],[0,98],[0,98],[0,98],[0,0],[0,0],[0,70],[0,70],
        [0,70],[0,70],[0,0],[56,0],[56,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
        [0,0],[82,0],[103,0],[0,0],[0,0],[103,0],[82,0],[0,0],[0,0],[0,98],[0,98],[0,98],
        [0,98],[0,59],[0,59],[0,100],[0,100],[0,100],[0,100],[0,160],[0,160],[0,160],[0,160],[0,88],
        [0,88],[0,88],[0,88],[0,0],[0,0],[0,0],[0,160],[0,160],[0,160],[0,160],[0,98],[0,98],
        [0,98],[0,98],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[150,0],[0,0],[160,0],
        [0,0],[0,0],[160,0],[103,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[110,0],[110,0],
        [56,0],[0,137],[0,137],[0,137],[0,137],[0,200],[0,200],[0,200],[0,200],[0,0],[0,0],[0,0],
        [0,0],[0,0],[95,0],[113,0],[0,0],[0,0],[113,0],[95,0],[0,0],[0,0],[0,0],[60,0],
        [60,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[113,0],[113,0],[113,0],[113,0],
        [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,115],[0,115],[0,115],[0,115],[0,90],[0,90],
        [0,90],[0,90],[0,0],[0,0],[0,0],[0,0],[0,0],[0,98],[0,98],[0,98],[0,98],[0,0],
        [0,0],[0,70],[0,70],[0,70],[0,70],[103,0],[103,0],[0,98],[0,98],[0,0],[0,0],[0,0],
        [0,0],[0,0],[0,0],[0,0],[0,0],[0,59],[0,59],[0,0],[0,0],[60,0],[0,0],[0,0],
        [0,0],[0,100],[0,100],[0,100],[0,100],[0,160],[0,160],[0,160],[0,160],[0,0],[0,0],[0,0],
        [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[103,0],[103,0],[103,0],[103,0],[0,0],
        [0,0],[0,0],[0,0],[103,0],[103,0],[103,0],[103,0],[0,0],[0,0],[0,0],[0,0],[0,0],
        [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
        [0,0],[0,0],[0,0],[0,117],[0,117],[0,117],[0,117],[0,0],[0,0],[0,0],[0,0],[0,73],
        [0,73],[0,73],[0,73],[0,83],[0,83],[0,83],[0,83],[0,0],[0,0],[0,0],[0,0],[0,0],
        [0,0],[0,0],[0,0],[0,0],[0,0],[0,137],[0,137],[0,137],[0,137],[0,137],[0,137],[0,137],
        [0,137],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[113,0],
        [113,0],[113,0],[113,0],[0,0],[0,0],[0,0],[0,0],[113,0],[113,0],[113,0],[113,0],[0,0],
        [0,0],[0,0],[0,0],[0,0],[0,0],[0,200],[0,200],[0,200],[0,200],[0,200],[0,200],[0,200],
        [0,200],[0,0],[0,0],[0,0],[0,0],[0,0],[180,0],[180,0],[0,0],[0,62],[0,62],[0,62],
        [0,62],[0,0],
    ];
    // Car entry flag bits (CarEntryFlag)
    const CAR_FLAG_NO_UPSTOPS = 1;
    const CAR_FLAG_NO_UPSTOPS_BOBSLEIGH = 2;
    // </generated-ride-data>

    // ------------------------------------------------------------------
    // Settings, logging
    // ------------------------------------------------------------------

    function getSetting(key, defaultValue) {
        try {
            const value = context.sharedStorage.get(STORE_PREFIX + key);
            return value === undefined || value === null ? defaultValue : value;
        } catch (e) {
            return defaultValue;
        }
    }

    function setSetting(key, value) {
        context.sharedStorage.set(STORE_PREFIX + key, value);
    }

    const activityLog = [];

    function log(message) {
        console.log('[' + PLUGIN_NAME + '] ' + message);
        activityLog.push(message);
        if (activityLog.length > LOG_SIZE) {
            activityLog.shift();
        }
        refreshStatusWindow();
    }

    class RpcError extends Error {
        constructor(message, data) {
            super(message);
            this.data = data;
        }
    }

    function fail(message, data) {
        throw new RpcError(message, data);
    }

    // ------------------------------------------------------------------
    // Generic helpers
    // ------------------------------------------------------------------

    function tileKey(x, y) {
        return x + ',' + y;
    }

    function pieceKey(x, y, z) {
        return x + ',' + y + ',' + z;
    }

    /** OpenRCT2 reports "no value" money as INT64_MIN; turn that into null. */
    function money(value) {
        return isNumber(value) && value > -9e18 ? value : null;
    }

    function formatMoney(value) {
        try {
            return context.formatString('{CURRENCY2DP}', value);
        } catch (e) {
            return String(value);
        }
    }

    function isNumber(v) {
        return typeof v === 'number' && isFinite(v);
    }

    function requireInt(params, name) {
        const v = params[name];
        if (!isNumber(v)) {
            fail('Parameter "' + name + '" must be a number.');
        }
        return Math.floor(v);
    }

    function optInt(params, name, defaultValue) {
        const v = params[name];
        return isNumber(v) ? Math.floor(v) : defaultValue;
    }

    function nextTick() {
        return new Promise(resolve => context.setTimeout(resolve, 0));
    }

    function statusName(code) {
        return STATUS_NAMES[code] || ('status' + code);
    }

    function describeResult(res) {
        if (!res) {
            return 'no result';
        }
        if (res.error === 0) {
            return 'ok';
        }
        const parts = [];
        if (res.errorTitle) parts.push(res.errorTitle);
        if (res.errorMessage) parts.push(res.errorMessage);
        if (parts.length === 0) parts.push(statusName(res.error));
        return parts.join(': ');
    }

    /** Height of a footpath piece's edge in a direction, or null if the piece cannot connect that way. */
    function edgeZ(z, slope, d) {
        if (slope < 0) return z;
        if (slope === d) return z + LAND_STEP;
        if (slope === (d ^ 2)) return z;
        return null;
    }

    function terrainPlacement(surface) {
        if (surface.slope & 0x10) return null;
        const entry = TERRAIN_PATH[surface.slope & 0x0F];
        switch (entry.t) {
            case 'flat': return { z: surface.z, s: -1 };
            case 'sloped': return { z: surface.z, s: entry.d };
            case 'raise': return { z: surface.z + LAND_STEP, s: -1 };
            default: return null;
        }
    }

    function getObjectName(type, index) {
        if (index === null || index === undefined) return null;
        try {
            const obj = objectManager.getObject(type, index);
            return obj ? obj.name : null;
        } catch (e) {
            return null;
        }
    }

    function getRideName(id) {
        try {
            const ride = map.getRide(id);
            return ride ? ride.name : null;
        } catch (e) {
            return null;
        }
    }

    function isSandbox() {
        try {
            return cheats.sandboxMode || context.mode === 'scenario_editor';
        } catch (e) {
            return false;
        }
    }

    function noMoney() {
        try {
            return park.getFlag('noMoney');
        } catch (e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Tile reading
    // ------------------------------------------------------------------

    /** Per-request cache of decoded tiles. */
    class TileCache {
        constructor() {
            this.tiles = new Map();
            this.size = map.size;
        }

        inBounds(x, y) {
            // The outermost ring of tiles is the map edge and cannot be built on.
            return x >= 1 && y >= 1 && x < this.size.x - 1 && y < this.size.y - 1;
        }

        get(x, y) {
            if (!this.inBounds(x, y)) return null;
            const key = x * 4096 + y;
            let info = this.tiles.get(key);
            if (info === undefined) {
                info = readTile(x, y);
                this.tiles.set(key, info);
            }
            return info;
        }
    }

    function readTile(x, y) {
        const tile = map.getTile(x, y);
        const elements = tile.elements;
        const info = {
            x: x,
            y: y,
            surface: null,
            paths: [],
            entrances: [],
            tracks: [],
            smallScenery: 0,
            largeScenery: 0,
            walls: [],
            banners: 0,
            onlySurface: true,
        };
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            const type = el.type;
            if (type === 'surface') {
                info.surface = {
                    z: el.baseZ,
                    slope: el.slope,
                    water: el.waterHeight,
                    owned: el.hasOwnership,
                    rights: el.hasConstructionRights,
                    ownership: el.ownership,
                };
                continue;
            }
            info.onlySurface = false;
            switch (type) {
                case 'footpath': {
                    const slopeDir = el.slopeDirection;
                    info.paths.push({
                        index: i,
                        z: el.baseZ,
                        s: slopeDir === null || slopeDir === undefined ? -1 : slopeDir,
                        queue: el.isQueue,
                        edges: el.edges & 0x0F,
                        ghost: el.isGhost,
                        surfaceObject: el.surfaceObject,
                        railingsObject: el.railingsObject,
                        legacyObject: el.object,
                        ride: el.ride,
                    });
                    break;
                }
                case 'entrance':
                    info.entrances.push({
                        index: i,
                        z: el.baseZ,
                        dir: el.direction,
                        type: el.object,
                        ride: el.ride,
                        station: el.station,
                        seq: el.sequence,
                        ghost: el.isGhost,
                    });
                    break;
                case 'track':
                    info.tracks.push({ ride: el.ride, z: el.baseZ, clearanceZ: el.clearanceZ, ghost: el.isGhost });
                    break;
                case 'small_scenery':
                    info.smallScenery++;
                    break;
                case 'large_scenery':
                    info.largeScenery++;
                    break;
                case 'wall':
                    if (!el.isGhost) info.walls.push({ dir: el.direction, z: el.baseZ, clearanceZ: el.clearanceZ });
                    break;
                case 'banner':
                    info.banners++;
                    break;
            }
        }
        if (info.surface) {
            info.terrain = terrainPlacement(info.surface);
        }
        return info;
    }

    /** Does a wall on edge d of this tile block a footpath piece (z, slope s) from connecting that way? */
    function wallBlocks(tileInfo, d, z, s) {
        if (!tileInfo || tileInfo.walls.length === 0) return false;
        const top = z + PATH_CLEARANCE + (s >= 0 ? LAND_STEP : 0);
        return tileInfo.walls.some(w => w.dir === d && z < w.clearanceZ && top > w.z);
    }

    /** Path element on a tile that connects back toward direction d at height h. */
    function pathConnectingAt(tileInfo, d, h, includeGhosts) {
        if (!tileInfo) return null;
        for (const p of tileInfo.paths) {
            if (p.ghost && !includeGhosts) continue;
            if (edgeZ(p.z, p.s, d) === h) return p;
        }
        return null;
    }

    /**
     * The existing path neighbour joined to path p (at x, y) in direction d. Two paths count as joined when
     * either of them has its edge bit set toward the other (edges are occasionally one-sided).
     */
    function connectedNeighbour(tc, x, y, p, d) {
        const h = edgeZ(p.z, p.s, d);
        if (h === null) return null;
        const n = tc.get(x + DIR_DX[d], y + DIR_DY[d]);
        const q = pathConnectingAt(n, d ^ 2, h, false);
        if (!q) return null;
        return (p.edges & (1 << d)) || (q.edges & (1 << (d ^ 2))) ? q : null;
    }

    /** Walks joined paths (queues included) from a start piece; true if any of them is in the network set. */
    function reachesNetwork(tc, x, y, p, network) {
        const seen = new Set([pieceKey(x, y, p.z)]);
        const queue = [[x, y, p]];
        while (queue.length > 0) {
            const [cx, cy, cp] = queue.pop();
            if (network.has(pieceKey(cx, cy, cp.z)) && !cp.queue) return true;
            for (let d = 0; d < 4; d++) {
                const q = connectedNeighbour(tc, cx, cy, cp, d);
                if (!q) continue;
                const nx = cx + DIR_DX[d];
                const ny = cy + DIR_DY[d];
                const key = pieceKey(nx, ny, q.z);
                if (seen.has(key)) continue;
                seen.add(key);
                queue.push([nx, ny, q]);
            }
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Park entrances and the park-connected path network
    // ------------------------------------------------------------------

    const parkEntranceCache = { list: null, scanning: null };

    function invalidateParkEntrances() {
        parkEntranceCache.list = null;
    }

    function stillValidParkEntrances(list) {
        for (const e of list) {
            const info = readTile(e.x, e.y);
            if (!info.entrances.some(en => en.type === ENTRANCE_PARK && en.seq === 0 && en.z === e.z)) {
                return false;
            }
        }
        return true;
    }

    /** Scans the whole map for park entrances, spread across ticks to avoid freezing the game. */
    async function getParkEntrances() {
        if (parkEntranceCache.list && stillValidParkEntrances(parkEntranceCache.list)) {
            return parkEntranceCache.list;
        }
        if (parkEntranceCache.scanning) {
            return parkEntranceCache.scanning;
        }
        parkEntranceCache.scanning = (async () => {
            const size = map.size;
            const found = [];
            const tilesPerTick = 8192;
            let counter = 0;
            for (let y = 0; y < size.y; y++) {
                for (let x = 0; x < size.x; x++) {
                    const elements = map.getTile(x, y).elements;
                    for (let i = 0; i < elements.length; i++) {
                        const el = elements[i];
                        if (el.type === 'entrance' && el.object === ENTRANCE_PARK && el.sequence === 0 && !el.isGhost) {
                            found.push({ x: x, y: y, z: el.baseZ, dir: el.direction });
                        }
                    }
                    if (++counter % tilesPerTick === 0) {
                        await nextTick();
                    }
                }
            }
            parkEntranceCache.list = found;
            return found;
        })();
        try {
            return await parkEntranceCache.scanning;
        } finally {
            parkEntranceCache.scanning = null;
        }
    }

    /** Set of piece keys for all non-queue paths reachable on foot from a park entrance. */
    function computeParkNetwork(tc, entrances) {
        const set = new Set();
        const queue = [];
        const visit = (x, y, p) => {
            const key = pieceKey(x, y, p.z);
            if (p.queue || p.ghost || set.has(key)) return;
            set.add(key);
            queue.push([x, y, p]);
        };
        for (const e of entrances) {
            for (const d of [e.dir, e.dir ^ 2]) {
                const nx = e.x + DIR_DX[d];
                const ny = e.y + DIR_DY[d];
                const p = pathConnectingAt(tc.get(nx, ny), d ^ 2, e.z, false);
                if (p) visit(nx, ny, p);
            }
        }
        while (queue.length > 0) {
            const [x, y, p] = queue.pop();
            for (let d = 0; d < 4; d++) {
                const q = connectedNeighbour(tc, x, y, p, d);
                if (q) visit(x + DIR_DX[d], y + DIR_DY[d], q);
            }
        }
        return set;
    }

    /** All non-queue existing paths, used as goals when the park has no entrance (e.g. in the editor). */
    function pathFragmentFrom(tc, x, y, p) {
        const set = new Set();
        const queue = [[x, y, p]];
        set.add(pieceKey(x, y, p.z));
        while (queue.length > 0) {
            const [cx, cy, cp] = queue.pop();
            for (let d = 0; d < 4; d++) {
                const q = connectedNeighbour(tc, cx, cy, cp, d);
                if (!q || q.queue) continue;
                const nx = cx + DIR_DX[d];
                const ny = cy + DIR_DY[d];
                const key = pieceKey(nx, ny, q.z);
                if (!set.has(key)) {
                    set.add(key);
                    queue.push([nx, ny, q]);
                }
            }
        }
        return set;
    }

    // ------------------------------------------------------------------
    // Ride helpers
    // ------------------------------------------------------------------

    function getRideOrFail(id) {
        if (!isNumber(id)) fail('Parameter "rideId" must be a number.');
        let ride = null;
        try {
            ride = map.getRide(id);
        } catch (e) {
            ride = null;
        }
        if (!ride) fail('No ride with id ' + id + '. Use list_rides to see valid ids.');
        return ride;
    }

    /** Locates the entrance/exit element for a station and works out where its path must go. */
    function describePortal(tc, coords, wantedType, rideId, stationIndex) {
        if (!coords) return null;
        const x = Math.floor(coords.x / TILE_SIZE);
        const y = Math.floor(coords.y / TILE_SIZE);
        const info = tc.get(x, y);
        let element = null;
        if (info) {
            element = info.entrances.find(e => e.type === wantedType && e.ride === rideId && e.station === stationIndex)
                || info.entrances.find(e => e.type === wantedType && e.ride === rideId)
                || null;
        }
        const z = element ? element.z : coords.z;
        const dir = element ? element.dir : coords.direction;
        // A path connects to an entrance from the tile "behind" it relative to its direction.
        const away = dir ^ 2;
        const front = { x: x + DIR_DX[away], y: y + DIR_DY[away] };
        const frontInfo = tc.get(front.x, front.y);
        const frontPath = frontInfo ? pathConnectingAt(frontInfo, dir, z, false) : null;
        const connected = !!(frontPath && (frontPath.edges & (1 << dir)));
        const connectedPath = connected ? frontPath : null;
        return {
            x: x,
            y: y,
            z: z,
            direction: dir,
            pathDirection: away,
            frontTile: front,
            connected: connected,
            connectedPath: connected
                ? { x: front.x, y: front.y, z: connectedPath.z, isQueue: connectedPath.queue, piece: connectedPath }
                : null,
            // A path at the right height that is not joined to the entrance/exit (e.g. built before it).
            unjoinedPath: frontPath && !connected ? frontPath : null,
        };
    }

    function rideStations(ride) {
        const out = [];
        const stations = ride.stations || [];
        for (let i = 0; i < stations.length; i++) {
            const st = stations[i];
            if (!st.start && !st.entrance && !st.exit) continue;
            out.push({ index: i, station: st });
        }
        return out;
    }

    /** Ride summary; `detailed` adds the fields only get_ride needs. */
    function summariseRide(tc, ride, network, detailed) {
        const stations = rideStations(ride).map(({ index, station }) => {
            const entrance = describePortal(tc, station.entrance, ENTRANCE_RIDE_ENTRANCE, ride.id, index);
            const exit = describePortal(tc, station.exit, ENTRANCE_RIDE_EXIT, ride.id, index);
            const portal = (p, kind) => {
                if (!p) return null;
                const out = { x: p.x, y: p.y, z: p.z, direction: p.direction, connected: p.connected };
                if (detailed) out.frontTile = p.frontTile;
                if (p.connectedPath) {
                    out.connectedPathIsQueue = p.connectedPath.isQueue;
                    if (network) {
                        out.reachesParkEntrance = kind === 'exit'
                            ? reachesNetwork(tc, p.connectedPath.x, p.connectedPath.y, p.connectedPath.piece, network)
                            : queueReachesNetwork(tc, p, network);
                    }
                } else if (p.unjoinedPath) {
                    out.note = 'A path at ' + p.frontTile.x + ',' + p.frontTile.y + ' is in front but not joined to it.';
                }
                return out;
            };
            const out = {
                index: index,
                start: station.start
                    ? { x: Math.floor(station.start.x / TILE_SIZE), y: Math.floor(station.start.y / TILE_SIZE), z: station.start.z }
                    : null,
                entrance: portal(entrance, 'entrance'),
                exit: portal(exit, 'exit'),
            };
            if (detailed) {
                out.length = station.length;
                out.queueTime = station.queueTime;
            }
            return out;
        });
        let objectName = null;
        try {
            objectName = ride.object ? ride.object.name : null;
        } catch (e) {
            objectName = null;
        }
        const summary = {
            id: ride.id,
            name: ride.name,
            object: objectName,
            classification: ride.classification,
            status: ride.status,
        };
        if (ride.classification === 'ride') {
            summary.excitement = ride.excitement / 100;
            summary.intensity = ride.intensity / 100;
            summary.nausea = ride.nausea / 100;
        }
        if (detailed) {
            summary.type = ride.type;
            summary.price = ride.price && ride.price.length ? ride.price[0] : null;
            summary.priceFormatted = summary.price !== null ? formatMoney(summary.price) : null;
            summary.totalCustomers = ride.totalCustomers;
        }
        // Stalls and facilities have no entrance/exit; their station list is noise in a summary.
        if (detailed || stations.some(st => st.entrance || st.exit)) {
            summary.stations = stations;
        } else if (stations.length > 0 && stations[0].start) {
            summary.location = stations[0].start;
        }
        return summary;
    }

    function rideNeedsPaths(summary) {
        return (summary.stations || []).some(st => [st.entrance, st.exit].some(p => p
            && (!p.connected || p.reachesParkEntrance === false)));
    }

    /** Follows a queue line from its entrance and reports whether it ends at the park-connected network. */
    function queueReachesNetwork(tc, portal, network) {
        if (!portal.connectedPath) return false;
        let x = portal.frontTile.x;
        let y = portal.frontTile.y;
        let p = portal.connectedPath.piece;
        const seen = new Set();
        for (let steps = 0; steps < 4096; steps++) {
            const key = pieceKey(x, y, p.z);
            if (!p.queue) return network.has(key);
            if (seen.has(key)) return false;
            seen.add(key);
            let next = null;
            for (let d = 0; d < 4 && !next; d++) {
                const q = connectedNeighbour(tc, x, y, p, d);
                if (!q) continue;
                const nx = x + DIR_DX[d];
                const ny = y + DIR_DY[d];
                if (seen.has(pieceKey(nx, ny, q.z))) continue;
                next = [nx, ny, q];
            }
            if (!next) return false;
            [x, y, p] = next;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Footpath object selection
    // ------------------------------------------------------------------

    function loadedObjects(type) {
        try {
            return objectManager.getAllObjects(type) || [];
        } catch (e) {
            return [];
        }
    }

    function findObjectIndex(type, ref) {
        if (ref === undefined || ref === null) return null;
        if (isNumber(ref)) return ref;
        const needle = String(ref).toLowerCase();
        for (const obj of loadedObjects(type)) {
            if (obj.identifier && obj.identifier.toLowerCase() === needle) return obj.index;
            if (obj.name && obj.name.toLowerCase() === needle) return obj.index;
        }
        fail('No loaded ' + type + ' object matches "' + ref + '". Use list_footpath_objects.');
    }

    /** Picks surface/railings objects: explicit params, else copy nearby paths, else first loaded objects. */
    function resolvePathStyle(tc, near, queue, params) {
        const surface = findObjectIndex('footpath_surface', params.surface);
        const railings = findObjectIndex('footpath_railings', params.railings);
        if (surface !== null) {
            return {
                object: surface,
                railingsObject: railings !== null ? railings : defaultRailings(),
                constructFlags: queue ? PATH_CONSTRUCT_QUEUE : 0,
                source: 'requested',
            };
        }

        // Copy the style of the nearest existing path of the same kind.
        if (near) {
            for (let r = 0; r <= 12; r++) {
                for (let dx = -r; dx <= r; dx++) {
                    for (let dy = -r; dy <= r; dy++) {
                        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                        const info = tc.get(near.x + dx, near.y + dy);
                        if (!info) continue;
                        for (const p of info.paths) {
                            if (p.ghost || p.queue !== queue) continue;
                            if (p.legacyObject !== null && p.legacyObject !== undefined) {
                                return {
                                    object: p.legacyObject,
                                    railingsObject: 0,
                                    constructFlags: (queue ? PATH_CONSTRUCT_QUEUE : 0) | PATH_CONSTRUCT_LEGACY,
                                    source: 'copied from path at ' + info.x + ',' + info.y,
                                };
                            }
                            if (p.surfaceObject !== null && p.surfaceObject !== undefined) {
                                return {
                                    object: p.surfaceObject,
                                    railingsObject: railings !== null ? railings
                                        : (p.railingsObject !== null && p.railingsObject !== undefined ? p.railingsObject : defaultRailings()),
                                    constructFlags: queue ? PATH_CONSTRUCT_QUEUE : 0,
                                    source: 'copied from path at ' + info.x + ',' + info.y,
                                };
                            }
                        }
                    }
                }
            }
        }

        const surfaces = loadedObjects('footpath_surface');
        const candidates = surfaces.filter(o => !(o.flags & SURFACE_FLAG_EDITOR_ONLY));
        const match = candidates.find(o => !!(o.flags & SURFACE_FLAG_QUEUE) === queue)
            || surfaces.find(o => !!(o.flags & SURFACE_FLAG_QUEUE) === queue);
        if (match) {
            return {
                object: match.index,
                railingsObject: railings !== null ? railings : defaultRailings(),
                constructFlags: queue ? PATH_CONSTRUCT_QUEUE : 0,
                source: 'default ' + match.identifier,
            };
        }

        const legacy = loadedObjects('footpath');
        if (legacy.length > 0) {
            return {
                object: legacy[0].index,
                railingsObject: 0,
                constructFlags: (queue ? PATH_CONSTRUCT_QUEUE : 0) | PATH_CONSTRUCT_LEGACY,
                source: 'legacy ' + legacy[0].identifier,
            };
        }
        fail('No footpath objects are loaded in this park.');
    }

    function defaultRailings() {
        const railings = loadedObjects('footpath_railings');
        return railings.length > 0 ? railings[0].index : 0;
    }

    // ------------------------------------------------------------------
    // Game action wrappers
    // ------------------------------------------------------------------

    function queryActionSync(name, args) {
        let result = null;
        try {
            context.queryAction(name, args, res => {
                result = res;
            });
        } catch (e) {
            return { error: -2, errorMessage: String(e && e.message ? e.message : e) };
        }
        return result || { error: -1, errorMessage: 'No result from query.' };
    }

    function executeAction(name, args) {
        return new Promise(resolve => {
            let done = false;
            let timer = null;
            const finish = res => {
                if (done) return;
                done = true;
                if (timer !== null) context.clearTimeout(timer);
                resolve(res);
            };
            timer = context.setTimeout(
                () => finish({ error: -1, errorMessage: 'Timed out waiting for the game to execute the action.' }),
                ACTION_TIMEOUT_MS);
            try {
                context.executeAction(name, args, res => finish(res));
            } catch (e) {
                finish({ error: -2, errorMessage: String(e && e.message ? e.message : e) });
            }
        });
    }

    function footpathArgs(piece, style, flags) {
        return {
            x: piece.x * TILE_SIZE,
            y: piece.y * TILE_SIZE,
            z: piece.z,
            direction: piece.dir === undefined || piece.dir === null ? 0xFF : piece.dir,
            object: style.object,
            railingsObject: style.railingsObject,
            slopeType: piece.s < 0 ? 0 : 1,
            slopeDirection: piece.s < 0 ? 0 : piece.s,
            constructFlags: style.constructFlags,
            flags: flags,
        };
    }

    /** Game action flags for a build request. Dry runs only query, so they may always plan while paused. */
    function buildFlags(params) {
        return params.allowWhilePaused || params.dryRun ? COMMAND_FLAG_ALLOW_DURING_PAUSED : 0;
    }

    function ensureCanBuild(params) {
        if (context.mode !== 'normal' && context.mode !== 'scenario_editor') {
            fail('No park is loaded (game mode is "' + context.mode + '").');
        }
        if (context.paused && !params.allowWhilePaused && !params.dryRun) {
            let pauseCheat = false;
            try {
                pauseCheat = cheats.buildInPauseMode;
            } catch (e) {
                pauseCheat = false;
            }
            if (!pauseCheat) {
                fail('The game is paused and construction is not allowed while paused. Ask the player whether to unpause '
                    + '(set_paused with paused=false) or retry with allowWhilePaused=true (equivalent to the '
                    + '"build while paused" cheat).');
            }
        }
    }

    // ------------------------------------------------------------------
    // Route search (A*) for footpaths
    // ------------------------------------------------------------------

    class MinHeap {
        constructor() {
            this.items = [];
        }

        get size() {
            return this.items.length;
        }

        push(item) {
            const a = this.items;
            a.push(item);
            let i = a.length - 1;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (a[parent].f <= item.f) break;
                a[i] = a[parent];
                i = parent;
            }
            a[i] = item;
        }

        pop() {
            const a = this.items;
            const top = a[0];
            const last = a.pop();
            if (a.length > 0) {
                let i = 0;
                for (;;) {
                    const l = 2 * i + 1;
                    const r = l + 1;
                    let m = i;
                    let mf = last.f;
                    if (l < a.length && a[l].f < mf) {
                        m = l;
                        mf = a[l].f;
                    }
                    if (r < a.length && a[r].f < mf) {
                        m = r;
                    }
                    if (m === i) break;
                    a[i] = a[m];
                    i = m;
                }
                a[i] = last;
            }
            return top;
        }
    }

    /**
     * Builds the context used by the router for one request.
     *  - queue: building a queue line (stricter about touching other paths)
     *  - style: footpath objects to place
     *  - flags: game action flags
     */
    function makeRouter(tc, opts) {
        const queryCache = new Map();
        const failureReasons = {};
        const sandbox = isSandbox();

        function noteFailure(reason) {
            failureReasons[reason] = (failureReasons[reason] || 0) + 1;
        }

        /** Can a new footpath piece be placed here? Uses the game's own placement checks. */
        function placement(info, z, s) {
            const surface = info.surface;
            if (!surface) return null;
            if (z < FOOTPATH_MIN_Z || z > FOOTPATH_MAX_Z) return null;
            // Tunnels are allowed (the game rejects digging into open ground itself), within a depth limit.
            if (z < Math.min(surface.z, opts.zFloor) - opts.maxElevation) return null;
            if (z > Math.max(surface.z + opts.maxElevation, opts.zCeiling)) return null;
            if (surface.water > 0 && z < surface.water) {
                noteFailure('under water');
                return null;
            }
            if (!sandbox && !surface.owned && !surface.rights) {
                noteFailure('land not owned by the park');
                return null;
            }
            const key = info.x + ',' + info.y + ',' + z + ',' + s;
            let res = queryCache.get(key);
            if (res === undefined) {
                const onTerrain = info.terrain && info.terrain.z === z && info.terrain.s === s;
                if (onTerrain && info.onlySurface && surface.owned) {
                    // Empty owned land with a matching slope: always placeable.
                    res = { ok: true, cost: null };
                } else {
                    const r = queryActionSync('footpathplace',
                        footpathArgs({ x: info.x, y: info.y, z: z, s: s }, opts.style, opts.flags));
                    if (r.error === 0) {
                        res = { ok: true, cost: r.cost };
                    } else {
                        res = { ok: false, error: r.error, reason: describeResult(r) };
                    }
                }
                queryCache.set(key, res);
                if (!res.ok) noteFailure(res.reason);
            }
            return res.ok ? res : null;
        }

        /**
         * Is (x, y) the tile in front of an entrance/exit other than the one being connected? Returns null, or
         * 'joins' when a piece at (z, s) would connect to it, or 'blocks' when it would sit there without
         * connecting (e.g. a slope across it) and so stop that entrance/exit ever getting a path.
         */
        function foreignPortalAt(x, y, z, s) {
            let result = null;
            for (let k = 0; k < 4; k++) {
                const m = tc.get(x + DIR_DX[k], y + DIR_DY[k]);
                if (!m) continue;
                for (const e of m.entrances) {
                    if (e.type === ENTRANCE_PARK || e.dir !== k) continue;
                    if (opts.allowedPortal && opts.allowedPortal.x === m.x && opts.allowedPortal.y === m.y) continue;
                    if (edgeZ(z, s, k) === e.z) {
                        result = e.type === ENTRANCE_RIDE_EXIT ? (result || 'joins') : 'blocks';
                    } else if (z < e.z + 2 * PATH_CLEARANCE && z + PATH_CLEARANCE + LAND_STEP > e.z) {
                        // Too close above or below: the entrance's own path would be boxed in under it.
                        result = 'blocks';
                    }
                }
            }
            return result;
        }

        /** Number of existing paths (other than in direction `except`) a new piece would merge with. */
        function adjacentPaths(x, y, z, s, except) {
            let count = 0;
            for (let k = 0; k < 4; k++) {
                if (k === except) continue;
                const h = edgeZ(z, s, k);
                if (h === null) continue;
                const nx = x + DIR_DX[k];
                const ny = y + DIR_DY[k];
                if (opts.reserved.has(tileKey(nx, ny))) {
                    count++;
                    continue;
                }
                if (pathConnectingAt(tc.get(nx, ny), k ^ 2, h, false)) count++;
            }
            return count;
        }

        /** Existing paths (or reserved route tiles) a new piece would join, ignoring direction `except`. */
        function joinableNeighbours(x, y, z, s, except) {
            const out = [];
            const here = tc.get(x, y);
            for (let k = 0; k < 4; k++) {
                if (k === except) continue;
                const h = edgeZ(z, s, k);
                if (h === null || wallBlocks(here, k, z, s)) continue;
                const nx = x + DIR_DX[k];
                const ny = y + DIR_DY[k];
                if (opts.reserved.has(tileKey(nx, ny))) {
                    out.push({ x: nx, y: ny, reserved: true });
                    continue;
                }
                const m = tc.get(nx, ny);
                const q = pathConnectingAt(m, k ^ 2, h, false);
                if (q && !wallBlocks(m, k ^ 2, q.z, q.s)) out.push({ x: nx, y: ny, p: q, dir: k });
            }
            return out;
        }

        /** True if (x, y) is on or next to any earlier tile of the route (other than the node we step from). */
        function nearOwnRoute(node, x, y) {
            let n = node.parent;
            for (let i = 0; n && i < 400; i++, n = n.parent) {
                if (n.virtual) continue;
                if (Math.abs(n.x - x) + Math.abs(n.y - y) <= 1) return true;
            }
            return false;
        }

        function isGoalPiece(x, y, p) {
            const goal = opts.goal;
            if (goal.kind === 'tile') return x === goal.x && y === goal.y;
            if (p.queue || p.ghost) return false;
            return goal.set.has(pieceKey(x, y, p.z));
        }

        /**
         * Runs the search, yielding to the game every so often so long searches never freeze it.
         * sources: [{ x, y, z, s, dir, existing, virtual, exits: [[d, h]] }]
         */
        async function search(sources) {
            const goal = opts.goal;
            const heap = new MinHeap();
            const best = new Map();
            // Slightly inflated heuristic (weighted A*): much faster, routes stay near-optimal.
            const field = goal.kind === 'network' ? distanceField(tc, goal.tiles) : null;
            const heuristic = goal.kind === 'tile'
                ? (x, y) => HEURISTIC_WEIGHT * (Math.abs(goal.x - x) + Math.abs(goal.y - y))
                : (x, y) => (field ? HEURISTIC_WEIGHT * Math.max(0, field(x, y) - 1) : 0);

            for (const src of sources) {
                const node = Object.assign({ g: 0, parent: null }, src);
                node.f = heuristic(src.x, src.y);
                heap.push(node);
            }

            let expanded = 0;
            while (heap.size > 0) {
                const node = heap.pop();
                if (node.isGoal) {
                    const path = [];
                    for (let n = node; n; n = n.parent) {
                        if (!n.virtual) path.push(n);
                    }
                    path.reverse();
                    if (node.goalVia) path.push(node.goalVia);
                    return { path: path, expanded: expanded };
                }
                if (node.key !== undefined && best.get(node.key) < node.g) continue;
                if (++expanded > opts.maxNodes) break;
                if (expanded % SEARCH_SLICE === 0) await nextTick();

                const exits = node.virtual ? node.exits : [0, 1, 2, 3]
                    .map(d => [d, edgeZ(node.z, node.s, d)])
                    .filter(e => e[1] !== null);

                for (const [d, h] of exits) {
                    if (!node.virtual && node.dir !== undefined && node.dir !== null && d === (node.dir ^ 2)) continue;
                    const nx = node.x + DIR_DX[d];
                    const ny = node.y + DIR_DY[d];
                    const info = tc.get(nx, ny);
                    if (!info) continue;
                    if (opts.reserved.has(tileKey(nx, ny))) continue;
                    const turn = !node.virtual && node.dir !== undefined && node.dir !== null && node.dir !== d ? 0.35 : 0;
                    if (!node.virtual && wallBlocks(tc.get(node.x, node.y), d, node.z, node.s)) {
                        noteFailure('wall or fence in the way');
                        continue;
                    }

                    const candidates = [
                        { z: h, s: -1 },
                        { z: h, s: d },
                        { z: h - LAND_STEP, s: d ^ 2 },
                    ];

                    // Two existing paths only count as joined if they are already connected.
                    const fromPiece = node.existing ? node.piece : null;

                    // Existing paths on the neighbour tile.
                    let occupied = false;
                    for (const p of info.paths) {
                        if (p.ghost) continue;
                        if (!candidates.some(c => c.z === p.z && c.s === p.s)) continue;
                        occupied = true;
                        if (fromPiece && !(fromPiece.edges & (1 << d)) && !(p.edges & (1 << (d ^ 2)))) continue;
                        if (wallBlocks(info, d ^ 2, p.z, p.s)) continue;
                        // Queue lines join the network only through the strict final-tile rule below.
                        if (opts.queue) continue;
                        if (isGoalPiece(nx, ny, p)) {
                            pushNode(heap, best, node,
                                { x: nx, y: ny, z: p.z, s: p.s, dir: d, existing: true, isGoal: true, piece: p },
                                0.1 + turn, 0);
                        } else if (opts.allowExistingTraversal && !opts.queue && !p.queue) {
                            pushNode(heap, best, node,
                                { x: nx, y: ny, z: p.z, s: p.s, dir: d, existing: true, piece: p },
                                0.3 + turn, heuristic(nx, ny));
                        }
                    }

                    // Park entrances count as part of the network.
                    if (goal.kind === 'network' && !node.existing && !opts.queue) {
                        for (const e of info.entrances) {
                            if (e.type === ENTRANCE_PARK && e.seq === 0 && e.z === h && (d === e.dir || d === (e.dir ^ 2))) {
                                pushNode(heap, best, node,
                                    { x: nx, y: ny, z: e.z, s: -1, dir: d, existing: true, isGoal: true, parkEntrance: true },
                                    0.1 + turn, 0);
                            }
                        }
                    }
                    if (occupied || info.entrances.length > 0) continue;

                    for (const c of candidates) {
                        if (wallBlocks(info, d ^ 2, c.z, c.s)) {
                            noteFailure('wall or fence in the way');
                            continue;
                        }
                        const ok = placement(info, c.z, c.s);
                        if (!ok) continue;
                        const foreign = foreignPortalAt(nx, ny, c.z, c.s);
                        if (foreign === 'blocks' || (foreign && opts.queue)) {
                            noteFailure('in front of another entrance or exit');
                            continue;
                        }

                        // A queue tile joins at most two neighbours (see FootpathConnectEdges): the entrance or
                        // previous queue tile first, then the normal path in the lowest direction. So intermediate
                        // queue tiles must not touch any other path, and the final tile must have a network path
                        // as its lowest-direction normal-path neighbour.
                        let goalVia = null;
                        if (opts.queue) {
                            if (nearOwnRoute(node, nx, ny)) continue;
                            const joins = joinableNeighbours(nx, ny, c.z, c.s, d ^ 2);
                            if (joins.length > 0) {
                                const j = joins.reduce((a, b) => (b.dir < a.dir ? b : a));
                                if (goal.kind !== 'network' || joins.some(q => q.reserved || q.p.queue) || !isGoalPiece(j.x, j.y, j.p)) {
                                    noteFailure('a queue tile here would also join another path');
                                    continue;
                                }
                                goalVia = { x: j.x, y: j.y, z: j.p.z, s: j.p.s, dir: j.dir, existing: true, piece: j.p };
                            }
                        }
                        let cost = 1 + turn;
                        if (c.s >= 0) cost += 0.25;
                        const terrain = info.terrain;
                        if (!terrain || terrain.z !== c.z || terrain.s !== c.s) {
                            // Elevated or tunnelled pieces need supports / digging and look worse.
                            cost += 1 + 0.25 * Math.abs(c.z - info.surface.z) / LAND_STEP;
                        }
                        if (foreign) cost += 6;
                        if (!opts.queue) {
                            cost += adjacentPaths(nx, ny, c.z, c.s, d ^ 2);
                        }
                        const isGoal = goalVia !== null || (goal.kind === 'tile' && nx === goal.x && ny === goal.y);
                        pushNode(heap, best, node,
                            { x: nx, y: ny, z: c.z, s: c.s, dir: d, existing: false, isGoal: isGoal, goalVia: goalVia },
                            cost, heuristic(nx, ny));
                    }
                }
            }
            return { path: null, expanded: expanded };
        }

        function pushNode(heap, best, parent, node, stepCost, h) {
            node.parent = parent;
            node.g = parent.g + stepCost;
            node.f = node.g + h;
            if (!node.isGoal) {
                node.key = node.x + ',' + node.y + ',' + node.z + ',' + node.s + ',' + node.dir;
                const prev = best.get(node.key);
                if (prev !== undefined && prev <= node.g) return;
                best.set(node.key, node.g);
            }
            heap.push(node);
        }

        return { search: search, placement: placement, failureReasons: failureReasons };
    }

    /**
     * Grid distance (ignoring obstacles) from every tile to the nearest of `tiles`, as a lookup function,
     * or null if unavailable. Used as the A* heuristic when the goal is a whole path network.
     */
    function distanceField(tc, tiles) {
        if (!tiles || tiles.length === 0) return null;
        const w = tc.size.x;
        const h = tc.size.y;
        if (w * h > 1024 * 1024) return null;
        const dist = new Int32Array(w * h).fill(-1);
        const queue = new Int32Array(w * h);
        let head = 0;
        let tail = 0;
        for (const [x, y] of tiles) {
            const i = y * w + x;
            if (x < 0 || y < 0 || x >= w || y >= h || dist[i] >= 0) continue;
            dist[i] = 0;
            queue[tail++] = i;
        }
        while (head < tail) {
            const i = queue[head++];
            const x = i % w;
            const y = (i - x) / w;
            const next = dist[i] + 1;
            if (x > 0 && dist[i - 1] < 0) { dist[i - 1] = next; queue[tail++] = i - 1; }
            if (x < w - 1 && dist[i + 1] < 0) { dist[i + 1] = next; queue[tail++] = i + 1; }
            if (y > 0 && dist[i - w] < 0) { dist[i - w] = next; queue[tail++] = i - w; }
            if (y < h - 1 && dist[i + w] < 0) { dist[i + w] = next; queue[tail++] = i + w; }
        }
        return (x, y) => dist[y * w + x];
    }

    function summariseFailures(failureReasons) {
        return Object.keys(failureReasons)
            .sort((a, b) => failureReasons[b] - failureReasons[a])
            .slice(0, 6)
            .map(k => k + ' (x' + failureReasons[k] + ')');
    }

    /** Source nodes for a route that must start by connecting to an entrance/exit. */
    function portalSource(portal) {
        return {
            x: portal.x,
            y: portal.y,
            virtual: true,
            exits: [[portal.pathDirection, portal.z]],
        };
    }

    /** Source nodes for a route starting on a given tile. */
    function tileSources(tc, x, y, z) {
        const info = tc.get(x, y);
        if (!info) fail('Tile ' + x + ',' + y + ' is outside the buildable map area.');
        const paths = info.paths.filter(p => !p.ghost && (z === null || p.z === z));
        if (paths.length > 0) {
            return paths.map(p => ({ x: x, y: y, z: p.z, s: p.s, existing: true, piece: p, dir: null }));
        }
        let piece = null;
        if (z !== null) {
            piece = { z: z, s: -1 };
        } else if (info.terrain) {
            piece = info.terrain;
        } else {
            fail('The terrain at ' + x + ',' + y + ' is too steep or irregular for a footpath; pass an explicit z for an elevated path.');
        }
        return [{ x: x, y: y, z: piece.z, s: piece.s, existing: false, startNew: true, dir: null }];
    }

    function sanitiseWaypoints(list) {
        if (!Array.isArray(list)) return [];
        return list.map(w => {
            if (!w || !isNumber(w.x) || !isNumber(w.y)) fail('Each waypoint must be an object with numeric x and y.');
            return { x: Math.floor(w.x), y: Math.floor(w.y) };
        });
    }

    /**
     * Shared engine for all route-building commands.
     * plan: { sources, goal, waypoints, queue, portal?, near, endpointZ }
     */
    async function planAndBuild(tc, plan, params) {
        ensureCanBuild(params);
        const dryRun = !!params.dryRun;
        const style = resolvePathStyle(tc, plan.near, plan.queue, params);
        const flags = buildFlags(params);
        const maxElevation = optInt(params, 'maxElevation', 6 * LAND_STEP);
        const maxNodes = Math.min(optInt(params, 'maxNodes', 40000), 400000);

        // Route through each waypoint in turn, then to the final goal.
        const legs = plan.waypoints.map(w => ({ kind: 'tile', x: w.x, y: w.y })).concat([plan.goal]);
        for (const leg of legs) {
            if (leg.kind !== 'tile') continue;
            const info = tc.get(leg.x, leg.y);
            if (!info || !info.surface) fail('Tile ' + leg.x + ',' + leg.y + ' is outside the buildable map area.');
            if (!isSandbox() && !info.surface.owned && !info.surface.rights) {
                fail('Tile ' + leg.x + ',' + leg.y + ' is not owned by the park, so nothing can be built there. '
                    + 'Buy the land first (e.g. execute_game_action "landbuyrights") or pick another tile.');
            }
        }
        const reserved = new Set();
        let sources = plan.sources;
        const fullPath = [];
        let expanded = 0;
        const failures = {};

        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i];
            const router = makeRouter(tc, {
                goal: leg,
                queue: plan.queue,
                style: style,
                flags: flags,
                maxElevation: maxElevation,
                zCeiling: plan.endpointZ,
                zFloor: plan.endpointZ,
                maxNodes: maxNodes,
                reserved: reserved,
                allowExistingTraversal: !plan.queue && leg.kind === 'network',
                allowedPortal: plan.portal ? { x: plan.portal.x, y: plan.portal.y } : null,
            });

            // A brand-new starting piece must itself be placeable.
            for (const s of sources) {
                if (s.startNew && !router.placement(tc.get(s.x, s.y), s.z, s.s)) {
                    fail('Cannot place a footpath on the starting tile ' + s.x + ',' + s.y + '.', {
                        reasons: summariseFailures(router.failureReasons),
                    });
                }
            }

            const result = await router.search(sources);
            expanded += result.expanded;
            Object.assign(failures, router.failureReasons);
            if (!result.path) {
                const target = leg.kind === 'tile' ? 'tile ' + leg.x + ',' + leg.y : 'the park\'s path network';
                fail('No buildable footpath route found to ' + target + ' (searched ' + result.expanded + ' positions).', {
                    commonBlockers: summariseFailures(failures),
                    hint: 'Check get_map_region around the area. Land may need to be bought, scenery cleared, or the '
                        + 'route given waypoints. maxElevation / maxNodes can be raised for long or elevated routes.',
                });
            }
            const path = result.path;
            // The first node of later legs repeats the last node of the previous leg.
            const startIndex = fullPath.length > 0 ? 1 : 0;
            for (let j = startIndex; j < path.length; j++) {
                fullPath.push(path[j]);
                reserved.add(tileKey(path[j].x, path[j].y));
            }
            const last = path[path.length - 1];
            if (i < legs.length - 1) {
                // Continue from the waypoint piece; it is not yet built, so it may only exit along its slope.
                sources = [{ x: last.x, y: last.y, z: last.z, s: last.s, dir: last.dir, existing: last.existing, piece: last.piece }];
            }
        }

        // An existing path straight in front of the entrance/exit that is not joined to it gets re-placed
        // with its own style, which makes the game recompute its connections (and costs nothing).
        const toRejoin = [];
        if (plan.portal && !plan.portal.connected && fullPath.length > 0 && fullPath[0].existing
            && fullPath[0].piece && !fullPath[0].parkEntrance) {
            const n = fullPath[0];
            toRejoin.push({ piece: { x: n.x, y: n.y, z: n.z, s: n.s, dir: n.dir }, style: styleOfPiece(n.piece) });
        }

        // Re-validate every new piece with a real query to get exact costs.
        // A queue line only needs to be so long; beyond that the route continues as a normal footpath.
        const maxQueue = plan.queue ? Math.max(1, optInt(params, 'queueLength', 12)) : Infinity;
        const pathStyle = plan.queue && fullPath.filter(n => !n.existing).length > maxQueue
            ? resolvePathStyle(tc, plan.near, false, Object.assign({}, params, { surface: params.pathSurface })) : style;
        const toBuild = [];
        let totalCost = 0;
        for (const node of fullPath) {
            if (node.existing) continue;
            const piece = { x: node.x, y: node.y, z: node.z, s: node.s, dir: node.dir };
            piece.style = toBuild.length < maxQueue ? style : pathStyle;
            const res = queryActionSync('footpathplace', footpathArgs(piece, piece.style, flags));
            if (res.error !== 0) {
                fail('Route validation failed at ' + piece.x + ',' + piece.y + ': ' + describeResult(res), {
                    status: statusName(res.error),
                });
            }
            totalCost += res.cost || 0;
            toBuild.push(piece);
        }

        if (!noMoney() && toBuild.length > 0 && totalCost > park.cash) {
            fail('Not enough cash: the route costs ' + formatMoney(totalCost) + ' but the park has ' + formatMoney(park.cash) + '.');
        }

        const route = fullPath.map(n => ({
            x: n.x, y: n.y, z: n.z,
            slope: n.s < 0 ? 'flat' : n.s,
            action: n.existing ? (n.parkEntrance ? 'park entrance' : 'existing path') : 'build',
        }));
        const summary = {
            dryRun: dryRun,
            kind: plan.queue ? 'queue' : 'footpath',
            style: describeStyle(style),
            tilesToBuild: toBuild.length,
            queueTiles: plan.queue ? Math.min(toBuild.length, maxQueue) : undefined,
            tilesToRejoin: toRejoin.length,
            estimatedCost: totalCost,
            estimatedCostFormatted: formatMoney(totalCost),
            searchedPositions: expanded,
            route: route,
        };
        if (dryRun) {
            return summary;
        }

        const promises = toBuild.map(piece => executeAction('footpathplace', footpathArgs(piece, piece.style, flags)))
            .concat(toRejoin.map(r => executeAction('footpathplace', footpathArgs(r.piece, r.style, flags))));
        const results = await Promise.all(promises);
        const rejoinResults = results.splice(toBuild.length);
        rejoinResults.forEach((res, i) => {
            if (res.error !== 0) {
                summary.errors = (summary.errors || []).concat([{
                    x: toRejoin[i].piece.x, y: toRejoin[i].piece.y, error: 'could not rejoin existing path: ' + describeResult(res),
                }]);
            }
        });
        let spent = 0;
        const errors = [];
        results.forEach((res, i) => {
            if (res.error === 0) {
                spent += res.cost || 0;
            } else {
                errors.push({ x: toBuild[i].x, y: toBuild[i].y, z: toBuild[i].z, error: describeResult(res) });
            }
        });
        summary.built = toBuild.length - errors.length;
        summary.cost = spent;
        summary.costFormatted = formatMoney(spent);
        if (errors.length > 0) summary.errors = (summary.errors || []).concat(errors);
        delete summary.estimatedCost;
        delete summary.estimatedCostFormatted;
        if (toBuild.length > 0) {
            log('Built ' + summary.built + ' ' + summary.kind + ' tile(s) for ' + summary.costFormatted);
        }
        return summary;
    }

    /** The placement style that reproduces an existing path element exactly. */
    function styleOfPiece(p) {
        if (p.legacyObject !== null && p.legacyObject !== undefined) {
            return {
                object: p.legacyObject,
                railingsObject: 0,
                constructFlags: (p.queue ? PATH_CONSTRUCT_QUEUE : 0) | PATH_CONSTRUCT_LEGACY,
                source: 'existing path',
            };
        }
        return {
            object: p.surfaceObject,
            railingsObject: p.railingsObject !== null && p.railingsObject !== undefined ? p.railingsObject : defaultRailings(),
            constructFlags: p.queue ? PATH_CONSTRUCT_QUEUE : 0,
            source: 'existing path',
        };
    }

    function describeStyle(style) {
        const legacy = !!(style.constructFlags & PATH_CONSTRUCT_LEGACY);
        return {
            surface: getObjectName(legacy ? 'footpath' : 'footpath_surface', style.object),
            railings: legacy ? null : getObjectName('footpath_railings', style.railingsObject),
            source: style.source,
        };
    }

    /**
     * Goal for routes that should join "the path network": every non-queue path reachable from a park
     * entrance. Without a park entrance (e.g. in the scenario editor) any existing non-queue path will
     * do, except those in `excludeFragment` (the fragment the route starts from).
     */
    async function networkGoal(tc, excludeFragment) {
        const entrances = await getParkEntrances();
        if (entrances.length > 0) {
            const set = computeParkNetwork(tc, entrances);
            const tiles = entrances.map(e => [e.x, e.y]);
            for (const key of set) {
                const [x, y] = key.split(',');
                tiles.push([+x, +y]);
            }
            return {
                kind: 'network',
                set: set,
                tiles: tiles,
                allPaths: false,
                description: 'path network connected to the park entrance',
            };
        }
        return {
            kind: 'network',
            set: { has: key => !(excludeFragment && excludeFragment.has(key)) && allPathKey(tc, key) },
            allPaths: true,
            description: 'any existing footpath (no park entrance found)',
        };
    }

    function allPathKey(tc, key) {
        const [x, y, z] = key.split(',').map(Number);
        const info = tc.get(x, y);
        return !!(info && info.paths.some(p => p.z === z && !p.queue && !p.ghost));
    }

    function findStationPortal(tc, ride, params, kind) {
        const stations = rideStations(ride);
        if (stations.length === 0) fail('Ride "' + ride.name + '" has no stations.');
        const wantedIndex = optInt(params, 'station', null);
        const type = kind === 'exit' ? ENTRANCE_RIDE_EXIT : ENTRANCE_RIDE_ENTRANCE;
        const candidates = stations.filter(s => wantedIndex === null || s.index === wantedIndex);
        if (candidates.length === 0) fail('Ride "' + ride.name + '" has no station ' + wantedIndex + '.');
        for (const { index, station } of candidates) {
            const coords = kind === 'exit' ? station.exit : station.entrance;
            if (!coords) continue;
            return { portal: describePortal(tc, coords, type, ride.id, index), stationIndex: index };
        }
        fail('Ride "' + ride.name + '" has no ' + kind + ' placed yet. Place one in-game (or with execute_action '
            + '"rideentranceexitplace") first.');
    }

    // ------------------------------------------------------------------
    // Ride building: ride types, availability, sites
    // ------------------------------------------------------------------

    const RIDE_STATUS = { closed: 0, open: 1, testing: 2, simulating: 3 };
    const TRACK_TOWER_BASE = 66;
    const SPECIAL_MAZE = 1;
    const SEQ_ORIGIN = 1 << 4;
    const SEQ_CONNECTS_TO_PATH = 1 << 5;

    function rideTypeInfo(rideType) {
        const row = RIDE_TYPE_DATA[rideType];
        if (!row) return null;
        const [name, category, startPiece, flagsLow, flagsHigh, groups, extraGroups, maxHeight, liftMin, liftMax, special,
            clearance, maxMass] = row;
        const has = flag => {
            const i = RTD_FLAGS[flag];
            if (i === undefined) return false;
            return i < 32 ? (flagsLow & (1 << i)) !== 0 : (flagsHigh & (1 << (i - 32))) !== 0;
        };
        let kind = 'tracked';
        if (has('isShopOrFacility')) kind = 'stall';
        else if (has('isFlatRide')) kind = 'flat';
        else if (special === SPECIAL_MAZE) kind = 'maze';
        else if (startPiece === TRACK_TOWER_BASE) kind = 'tower';
        return {
            id: rideType, name: name, category: RIDE_CATEGORIES[category] || null, startPiece: startPiece, has: has,
            groups: groups, extraGroups: extraGroups, maxHeight: maxHeight, liftMin: liftMin, liftMax: liftMax,
            special: special, kind: kind, clearance: clearance, maxMass: maxMass,
        };
    }

    /**
     * Height range [low, high) one block of a placed piece occupies, as TrackPlaceAction computes it. rideClearance
     * is the ride's clearance height (the ride type's default; ride objects may differ slightly).
     */
    function blockSpan(trackType, blockIndex, z, rideClearance) {
        const raw = (TRACK_BLOCK_CLEARANCE[trackType] || [])[blockIndex] || 0;
        const vertical = raw >= 256;
        const extra = vertical && rideClearance > 24 ? 24 : rideClearance;
        const low = Math.floor(z / 8) * 8;
        return { low: low, high: low + Math.floor(((raw & 0xFF) + extra) / 8) * 8 };
    }

    /** Height spans per tile (key -> [{low, high}]) a walked layout will occupy once placed at (ox, oy, baseZ). */
    function layoutOccupancy(walked, ox, oy, baseZ, rideClearance) {
        const occ = new Map();
        for (const p of walked.pieces) {
            p.blocks.forEach((b, i) => {
                const key = tileKey(ox + Math.floor(b.x / TILE_SIZE), oy + Math.floor(b.y / TILE_SIZE));
                if (!occ.has(key)) occ.set(key, []);
                occ.get(key).push(blockSpan(p.el.type, i, baseZ + b.z, rideClearance));
            });
        }
        return occ;
    }

    /** Does anything in occ on tile (x, y) overlap heights [low, high)? */
    function spanOccupied(occ, x, y, low, high) {
        const spans = occ.get(tileKey(x, y));
        return !!spans && spans.some(s => s.low < high && s.high > low);
    }

    /** Footprint of a single-piece ride (flat ride, stall, tower base) as tile offsets for direction 0. */
    function pieceFootprint(trackType) {
        let seg = null;
        try {
            seg = context.getTrackSegment(trackType);
        } catch (e) {
            seg = null;
        }
        if (!seg) return null;
        const tiles = seg.elements.map(e => ({ x: Math.round(e.x / TILE_SIZE), y: Math.round(e.y / TILE_SIZE) }));
        const xs = tiles.map(t => t.x);
        const ys = tiles.map(t => t.y);
        return {
            tiles: tiles,
            minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
            width: Math.max(...xs) - Math.min(...xs) + 1,
            length: Math.max(...ys) - Math.min(...ys) + 1,
        };
    }

    /** Rotate a tile offset by a direction (CoordsXY::Rotate). */
    function rotate(x, y, direction) {
        switch (direction & 3) {
            case 0: return { x: x, y: y };
            case 1: return { x: y, y: -x };
            case 2: return { x: -x, y: -y };
            default: return { x: -y, y: x };
        }
    }

    function ignoreResearch() {
        try {
            return !!cheats.ignoreResearchStatus;
        } catch (e) {
            return false;
        }
    }

    /** Ride objects the player may build right now (invented, or every loaded ride with the research cheat). */
    function buildableRideOptions() {
        const out = [];
        const seen = new Set();
        const add = (obj, rideType, category) => {
            const key = obj.index + ':' + rideType;
            if (seen.has(key)) return;
            seen.add(key);
            const info = rideTypeInfo(rideType);
            if (!info) return;
            const option = {
                object: obj.index,
                identifier: obj.identifier,
                legacyIdentifier: obj.legacyIdentifier || null,
                name: obj.name,
                rideType: rideType,
                rideTypeName: info.name,
                category: category || info.category,
                kind: info.kind,
                description: obj.description,
            };
            if (info.kind === 'flat' || info.kind === 'stall' || info.kind === 'tower') {
                const fp = pieceFootprint(info.startPiece);
                if (fp) option.footprint = { width: fp.width, length: fp.length };
            }
            out.push(option);
        };
        if (ignoreResearch()) {
            for (const obj of loadedObjects('ride')) {
                for (const rideType of obj.rideType || []) {
                    if (rideType !== 255 && rideType < RIDE_TYPE_DATA.length) add(obj, rideType, null);
                }
            }
        } else {
            let items = [];
            try {
                items = park.research.inventedItems;
            } catch (e) {
                items = [];
            }
            for (const item of items) {
                if (item.type !== 'ride') continue;
                let obj = null;
                try {
                    obj = objectManager.getObject('ride', item.object);
                } catch (e) {
                    obj = null;
                }
                if (obj) add(obj, item.rideType, item.category);
            }
        }
        return out;
    }

    /** Picks the ride the request refers to (object index/identifier, ride type, or a name search). */
    function resolveRideOption(params, kinds) {
        const options = buildableRideOptions().filter(o => !kinds || kinds.includes(o.kind));
        const describe = () => options.slice(0, 40).map(o => o.name + ' (' + o.kind + ', ' + o.category + ')').join(', ');
        let matches = options;
        if (params.object !== undefined && params.object !== null) {
            const ref = params.object;
            matches = options.filter(o => o.object === ref || o.identifier === ref
                || (typeof ref === 'string' && o.name.toLowerCase() === ref.toLowerCase()));
        } else if (isNumber(params.rideType)) {
            matches = options.filter(o => o.rideType === params.rideType);
        } else if (typeof params.ride === 'string') {
            const needle = params.ride.toLowerCase();
            matches = options.filter(o => o.name.toLowerCase() === needle);
            if (matches.length === 0) {
                matches = options.filter(o => o.name.toLowerCase().includes(needle) || o.rideTypeName.includes(needle.replace(/ /g, '_')));
            }
        } else {
            fail('Say which ride to build with "ride" (a name such as "Twist"), "object" or "rideType". '
                + 'list_buildable_rides shows what is available.');
        }
        if (params.category) matches = matches.filter(o => o.category === params.category);
        if (matches.length === 0) {
            fail('No buildable ride matches that request. Available: ' + describe()
                + (options.length > 40 ? ', ...' : '') + '. Rides must be researched first.');
        }
        return matches[0];
    }

    // --- water and site finding -------------------------------------

    const waterCache = { tiles: null };

    function invalidateWaterCache() {
        waterCache.tiles = null;
    }

    async function waterTiles() {
        if (waterCache.tiles) return waterCache.tiles;
        const size = map.size;
        const out = [];
        let counter = 0;
        for (let y = 1; y < size.y - 1; y++) {
            for (let x = 1; x < size.x - 1; x++) {
                const elements = map.getTile(x, y).elements;
                for (let i = 0; i < elements.length; i++) {
                    const el = elements[i];
                    if (el.type === 'surface') {
                        if (el.waterHeight > el.baseZ) out.push([x, y]);
                        break;
                    }
                }
                if (++counter % 8192 === 0) await nextTick();
            }
        }
        waterCache.tiles = out;
        return out;
    }

    /**
     * Finds open, owned, level areas for a footprint (plus a free ring for entrances and paths), scored by how
     * close they are to the target (water or a tile) and to the park's existing paths.
     *  opts: { width, length, margin, near: 'water' | {x, y}, radius, maxResults, anyTerrain }
     *  anyTerrain: the footprint only has to be free, not level (tracked rides stand on supports).
     */
    async function findSites(tc, opts) {
        const size = map.size;
        const radius = Math.min(Math.max(opts.radius || 12, 2), 64);
        let targets;
        if (opts.near === 'water') {
            targets = await waterTiles();
            if (targets.length === 0) fail('There is no water in this park.');
        } else if (opts.near && isNumber(opts.near.x) && isNumber(opts.near.y)) {
            targets = [[Math.floor(opts.near.x), Math.floor(opts.near.y)]];
        } else {
            fail('"near" must be "water" or a tile {x, y}.');
        }

        // Search window: around the targets, clipped to the map and to a sane size.
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (const [x, y] of targets) {
            x1 = Math.min(x1, x);
            y1 = Math.min(y1, y);
            x2 = Math.max(x2, x);
            y2 = Math.max(y2, y);
        }
        x1 = Math.max(1, x1 - radius);
        y1 = Math.max(1, y1 - radius);
        x2 = Math.min(size.x - 2, x2 + radius);
        y2 = Math.min(size.y - 2, y2 + radius);
        const w = x2 - x1 + 1;
        const h = y2 - y1 + 1;
        if (w * h > 260 * 260) fail('Search area too large; give a tile with "near" or a smaller radius.');

        const sandbox = isSandbox();
        const free = new Uint8Array(w * h);      // owned, empty, dry
        const level = new Int32Array(w * h).fill(-1); // flat surface height or -1
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const info = tc.get(x1 + x, y1 + y);
                if (!info || !info.surface) continue;
                const s = info.surface;
                if (!sandbox && !s.owned) continue;
                if (opts.anyTerrain) {
                    // Tracked rides stand on supports: water and small scenery (cleared by the game) are fine.
                    if (info.paths.length || info.entrances.length || info.tracks.length || info.largeScenery || info.walls.length) continue;
                } else if (!info.onlySurface || s.water > s.z) {
                    continue;
                }
                free[y * w + x] = 1;
                if ((s.slope & 0x1F) === 0) level[y * w + x] = s.z;
            }
            if (y % 32 === 31) await nextTick();
        }

        // Distance from every tile in the window to the nearest target (and to the path network).
        const distTo = sources => {
            const dist = new Int32Array(w * h).fill(-1);
            const queue = new Int32Array(w * h);
            let head = 0;
            let tail = 0;
            for (const [sx, sy] of sources) {
                const lx = sx - x1;
                const ly = sy - y1;
                if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
                const i = ly * w + lx;
                if (dist[i] >= 0) continue;
                dist[i] = 0;
                queue[tail++] = i;
            }
            while (head < tail) {
                const i = queue[head++];
                const x = i % w;
                const y = (i - x) / w;
                const nd = dist[i] + 1;
                if (x > 0 && dist[i - 1] < 0) { dist[i - 1] = nd; queue[tail++] = i - 1; }
                if (x < w - 1 && dist[i + 1] < 0) { dist[i + 1] = nd; queue[tail++] = i + 1; }
                if (y > 0 && dist[i - w] < 0) { dist[i - w] = nd; queue[tail++] = i - w; }
                if (y < h - 1 && dist[i + w] < 0) { dist[i + w] = nd; queue[tail++] = i + w; }
            }
            return dist;
        };
        const targetDist = distTo(targets);
        const entrances = await getParkEntrances();
        const networkTiles = [];
        for (const key of computeParkNetwork(tc, entrances)) {
            const [nx, ny] = key.split(',');
            networkTiles.push([+nx, +ny]);
        }
        const pathDist = networkTiles.length > 0 ? distTo(networkTiles) : null;

        const fw = opts.width;
        const fl = opts.length;
        const margin = opts.margin === undefined ? 1 : opts.margin;
        const ow = fw + 2 * margin;
        const ol = fl + 2 * margin;
        const used = new Uint8Array(w * h);
        const candidates = [];
        for (let y = 0; y + ol <= h; y++) {
            for (let x = 0; x + ow <= w; x++) {
                let ok = true;
                let z = null;
                let nearest = Infinity;
                let nearPath = Infinity;
                for (let dy = 0; dy < ol && ok; dy++) {
                    for (let dx = 0; dx < ow; dx++) {
                        const i = (y + dy) * w + (x + dx);
                        if (!free[i]) {
                            ok = false;
                            break;
                        }
                        const inner = dx >= margin && dx < margin + fw && dy >= margin && dy < margin + fl;
                        if (inner && !opts.anyTerrain) {
                            if (level[i] < 0 || (z !== null && level[i] !== z)) {
                                ok = false;
                                break;
                            }
                            z = level[i];
                        } else {
                            if (targetDist[i] >= 0) nearest = Math.min(nearest, targetDist[i]);
                            if (pathDist && pathDist[i] >= 0) nearPath = Math.min(nearPath, pathDist[i]);
                        }
                    }
                }
                if (!ok || nearest === Infinity || nearest > radius) continue;
                const score = nearest * 3 + Math.min(nearPath, 40) * 0.5;
                candidates.push({ x: x, y: y, z: z, score: score, distanceToTarget: nearest, distanceToPath: nearPath });
            }
            if (y % 16 === 15) await nextTick();
        }
        candidates.sort((a, b) => a.score - b.score);

        const results = [];
        const maxResults = opts.maxResults || 5;
        for (const c of candidates) {
            let clash = false;
            for (let dy = 0; dy < ol && !clash; dy++) {
                for (let dx = 0; dx < ow; dx++) {
                    if (used[(c.y + dy) * w + (c.x + dx)]) {
                        clash = true;
                        break;
                    }
                }
            }
            if (clash) continue;
            for (let dy = 0; dy < ol; dy++) {
                for (let dx = 0; dx < ow; dx++) used[(c.y + dy) * w + (c.x + dx)] = 1;
            }
            results.push({
                // Top-left tile of the footprint itself (inside the margin).
                x: x1 + c.x + margin,
                y: y1 + c.y + margin,
                z: c.z,
                width: fw,
                length: fl,
                distanceToTarget: c.distanceToTarget,
                distanceToPath: c.distanceToPath === Infinity ? null : c.distanceToPath,
            });
            if (results.length >= maxResults) break;
        }
        return results;
    }

    // --- placing single-piece rides ---------------------------------

    /** Tiles a single-piece ride occupies when its origin is at (ox, oy) facing `direction`. */
    function placedFootprint(fp, ox, oy, direction) {
        return fp.tiles.map(t => {
            const r = rotate(t.x, t.y, direction);
            return { x: ox + r.x, y: oy + r.y };
        });
    }

    /** Origin that puts the rotated footprint's top-left corner at (left, top). */
    function originForCorner(fp, left, top, direction) {
        const tiles = fp.tiles.map(t => rotate(t.x, t.y, direction));
        const minX = Math.min(...tiles.map(t => t.x));
        const minY = Math.min(...tiles.map(t => t.y));
        return { x: left - minX, y: top - minY };
    }

    /**
     * Where entrances/exits (or, for stalls, paths) may attach to a placed single-piece ride, from the track
     * piece's sequence flags. Each entry gives the entrance tile, the direction it must face (toward the ride)
     * and the tile in front of it where the path goes.
     */
    function attachmentPoints(trackType, fp, ox, oy, direction) {
        const flags = TRACK_SEQUENCE_FLAGS[trackType] || [];
        const tiles = placedFootprint(fp, ox, oy, direction);
        const occupied = new Set(tiles.map(t => tileKey(t.x, t.y)));
        const out = [];
        tiles.forEach((t, i) => {
            const sides = (flags[i] || 0) & 0x0F;
            for (let k = 0; k < 4; k++) {
                if (!(sides & (1 << k))) continue;
                const out1 = (k + direction) & 3;
                const ex = t.x + DIR_DX[out1];
                const ey = t.y + DIR_DY[out1];
                if (occupied.has(tileKey(ex, ey))) continue;
                out.push({
                    x: ex, y: ey,
                    direction: out1 ^ 2,
                    front: { x: ex + DIR_DX[out1], y: ey + DIR_DY[out1] },
                    rideTile: t,
                    connectsToPath: ((flags[i] || 0) & SEQ_CONNECTS_TO_PATH) !== 0,
                });
            }
        });
        return out;
    }

    function rideActionArgs(rideId, trackType, rideType, x, y, z, direction, extra) {
        return Object.assign({
            x: x * TILE_SIZE, y: y * TILE_SIZE, z: z, direction: direction,
            ride: rideId, trackType: trackType, rideType: rideType,
            brakeSpeed: 0, colour: 0, seatRotation: 4, trackPlaceFlags: 0, isFromTrackDesign: false,
        }, extra || {});
    }

    function defaultStationObject() {
        const stations = loadedObjects('station');
        const plain = stations.find(o => o.identifier === 'rct2.station.plain');
        return plain ? plain.index : (stations.length > 0 ? stations[0].index : 0);
    }

    async function createRide(option, params, flags) {
        const res = await executeAction('ridecreate', {
            rideType: option.rideType,
            rideObject: option.object,
            entranceObject: params.stationStyle !== undefined
                ? findObjectIndex('station', params.stationStyle) : defaultStationObject(),
            colour1: 0,
            colour2: 0,
            inspectionInterval: 2,
            flags: flags,
        });
        if (res.error !== 0 || !isNumber(res.ride)) fail('Could not create the ride: ' + describeResult(res));
        return res.ride;
    }

    async function demolishRide(rideId, flags) {
        return executeAction('ridedemolish', { ride: rideId, modifyType: 0, flags: flags });
    }

    /** Scores usable entrance/exit spots (at station height z) by how cheaply their front tile reaches the paths. */
    function rankAttachments(tc, points, networkField, z, height) {
        return points
            .map(p => {
                const front = tc.get(p.front.x, p.front.y);
                const ok = portalSpotOk(tc, p.x, p.y, z, p.front.x, p.front.y, height);
                const d = networkField ? networkField(p.front.x, p.front.y) : 0;
                const frontHasPath = !!(front && front.paths.some(q => !q.ghost));
                return Object.assign({ ok: ok, distance: d < 0 ? 999 : d, frontHasPath: frontHasPath }, p);
            })
            .filter(p => p.ok)
            .sort((a, b) => a.distance - b.distance);
    }

    /** How many ways a path could leave tile (x, y) at height z, not counting the way back to (fromX, fromY). */
    function pathExits(tc, x, y, z, fromX, fromY, own) {
        let count = 0;
        for (let k = 0; k < 4; k++) {
            const nx = x + DIR_DX[k];
            const ny = y + DIR_DY[k];
            if (nx === fromX && ny === fromY) continue;
            const info = tc.get(nx, ny);
            if (!info || !info.surface || info.entrances.length > 0 || info.largeScenery) continue;
            if (!isSandbox() && !info.surface.owned && !info.surface.rights) continue;
            if (info.surface.water > z || surfaceTop(info) > z + LAND_STEP) continue;
            if (info.tracks.some(t => t.z < z + PATH_CLEARANCE + LAND_STEP && t.clearanceZ > z - LAND_STEP)) continue;
            if (own && spanOccupied(own, nx, ny, z - LAND_STEP, z + PATH_CLEARANCE + LAND_STEP)) continue;
            count++;
        }
        return count;
    }

    /**
     * Can the tile beside a stall's open side carry a footpath at height z (or does it already)? The game joins
     * a stall to a path on exactly that tile (FootpathConnectEdges checks the shop's path-connecting side). Another
     * ride's queue line will not do: guests could not walk from it to the stall.
     */
    function stallSpotOk(tc, x, y, z) {
        const spot = tc.get(x, y);
        if (!spot || !spot.surface) return false;
        if (spot.paths.some(p => !p.ghost && !p.queue && p.z === z && p.s < 0)) return true;
        if (spot.paths.length || spot.entrances.length || spot.largeScenery) return false;
        const elevated = surfaceTop(spot) < z;
        if (!isSandbox() && !spot.surface.owned && !(spot.surface.rights && elevated)) return false;
        if (spot.tracks.some(t => t.z < z + PATH_CLEARANCE && t.clearanceZ > z)) return false;
        return spot.surface.water <= z && surfaceTop(spot) <= z;
    }

    function chooseEntranceAndExit(ranked) {
        // The entrance needs a free tile in front for its queue line; an exit may open straight onto a path.
        const usable = p => !p.frontHasPath && p.canBeEntrance !== false;
        const entrance = ranked.find(p => usable(p) && p.distance >= 2) || ranked.find(usable);
        if (!entrance) return null;
        const apart = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        // Keep the exit away from the entrance so the queue and the exit path do not merge.
        const exit = ranked.find(p => p !== entrance && apart(p, entrance) >= 3 && apart(p.front, entrance.front) >= 3)
            || ranked.find(p => p !== entrance && apart(p, entrance) >= 2 && apart(p.front, entrance.front) >= 2)
            || ranked.find(p => p !== entrance);
        return exit ? { entrance: entrance, exit: exit } : null;
    }

    // ------------------------------------------------------------------
    // Track layouts: replaying track designs and custom coasters
    // ------------------------------------------------------------------

    const TRACK_PLACE_LIFT_HILL = 1 << 0;
    const TRACK_PLACE_INVERTED = 1 << 1;
    const STATION_TRACK_TYPES = [1, 2, 3];
    const STATION_STYLES = [
        'rct2.station.plain', 'rct2.station.wooden', 'rct2.station.canvas_tent', 'rct2.station.castle_grey',
        'rct2.station.castle_brown', 'rct2.station.jungle', 'rct2.station.log', 'rct2.station.classical',
        'rct2.station.abstract', 'rct2.station.snow', 'rct2.station.pagoda', 'rct2.station.space',
        'openrct2.station.noentrance',
    ];
    // RCT2 ride types that OpenRCT2 splits by vehicle (RCT2RideTypeToOpenRCT2RideType).
    const RCT2_RIDE_TYPE_VARIANTS = { 19: [19, 91], 4: [4, 95], 11: [11, 93], 51: [51, 92], 54: [54, 94] };

    const segmentCache = new Map();

    function trackSegment(type) {
        if (segmentCache.has(type)) return segmentCache.get(type);
        let seg = null;
        try {
            seg = context.getTrackSegment(type);
        } catch (e) {
            seg = null;
        }
        const out = seg ? {
            type: type,
            name: TRACK_TYPE_NAMES[type] || String(type),
            description: seg.description,
            beginZ: seg.beginZ,
            endZ: seg.endZ,
            endX: seg.endX,
            endY: seg.endY,
            beginDirection: seg.beginDirection,
            endDirection: seg.endDirection,
            beginSlope: seg.beginSlope,
            endSlope: seg.endSlope,
            beginBank: seg.beginBank,
            endBank: seg.endBank,
            trackGroup: seg.trackGroup,
            allowsChainLift: seg.allowsChainLift,
            isInversion: seg.isInversion,
            turnDirection: seg.turnDirection,
            startsHalfHeightUp: seg.startsHalfHeightUp,
            isHelix: seg.isHelix,
            length: seg.length,
            subLength: seg.getSubpositionLength(0, 0),
            blocks: seg.elements.map(e => ({ x: e.x, y: e.y, z: e.z })),
        } : null;
        segmentCache.set(type, out);
        return out;
    }

    /**
     * Walks a layout from a relative origin (0, 0, 0) facing `direction`, exactly like TrackDesignPlaceRide:
     * each piece goes at (pos, z - beginZ, rotation & 3); then the position advances by the rotated end offset,
     * the rotation turns, and unless the piece ends diagonally the position steps one tile forward.
     */
    function walkLayout(elements, direction) {
        let x = 0;
        let y = 0;
        let z = 0;
        let rot = direction & 3;
        const pieces = [];
        elements.forEach((el, index) => {
            const seg = trackSegment(el.type);
            if (!seg) fail('Unknown track piece type ' + el.type + ' at position ' + index + '.');
            const placeZ = z - seg.beginZ;
            const blocks = seg.blocks.map(b => {
                const r = rotate(b.x, b.y, rot);
                return { x: x + r.x, y: y + r.y, z: placeZ + b.z };
            });
            pieces.push({ index: index, el: el, seg: seg, x: x, y: y, z: placeZ, direction: rot & 3, blocks: blocks });
            const off = rotate(seg.endX, seg.endY, rot);
            x += off.x;
            y += off.y;
            z = z - seg.beginZ + seg.endZ;
            rot = (rot + seg.endDirection - seg.beginDirection) & 3;
            if (seg.endDirection & 4) {
                rot |= 4;
            } else {
                x += DIR_DX[rot & 3] * TILE_SIZE;
                y += DIR_DY[rot & 3] * TILE_SIZE;
            }
        });
        return { pieces: pieces, end: { x: x, y: y, z: z, direction: rot } };
    }

    /** Tiles (relative to the origin tile) covered by a walked layout plus its entrances. */
    function layoutTiles(walked, entrances, direction) {
        const tiles = new Map();
        for (const p of walked.pieces) {
            for (const b of p.blocks) {
                const tx = Math.floor(b.x / TILE_SIZE);
                const ty = Math.floor(b.y / TILE_SIZE);
                tiles.set(tileKey(tx, ty), { x: tx, y: ty });
            }
        }
        for (const e of entrances || []) {
            const r = rotate(e.x, e.y, direction);
            const tx = Math.floor(r.x / TILE_SIZE);
            const ty = Math.floor(r.y / TILE_SIZE);
            tiles.set(tileKey(tx, ty), { x: tx, y: ty });
        }
        const list = Array.from(tiles.values());
        return {
            tiles: list,
            minX: Math.min(...list.map(t => t.x)), maxX: Math.max(...list.map(t => t.x)),
            minY: Math.min(...list.map(t => t.y)), maxY: Math.max(...list.map(t => t.y)),
        };
    }

    /** Highest point of a tile's surface, or the water level if higher (as TrackDesignPlace's getPlaceZ). */
    function surfaceTop(info) {
        const s = info.surface;
        let z = s.z;
        if (s.slope & 0x0F) {
            z += LAND_STEP;
            if (s.slope & 0x10) z += LAND_STEP;
        }
        return Math.max(z, s.water || 0);
    }

    /** Base height for a layout with its origin on tile (ox, oy): every block must clear terrain and water. */
    function layoutBaseZ(tc, walked, ox, oy) {
        const origin = tc.get(ox, oy);
        if (!origin || !origin.surface) return null;
        let z = Math.max(origin.surface.z, origin.surface.water || 0);
        for (const p of walked.pieces) {
            for (const b of p.blocks) {
                const info = tc.get(ox + Math.floor(b.x / TILE_SIZE), oy + Math.floor(b.y / TILE_SIZE));
                if (!info || !info.surface) return null;
                z = Math.max(z, surfaceTop(info) - b.z);
            }
        }
        return Math.ceil(z / 8) * 8;
    }

    function trackPlaceArgs(rideId, rideType, piece, ox, oy, baseZ, flags) {
        const el = piece.el;
        let placeFlags = 0;
        if (el.chain) placeFlags |= TRACK_PLACE_LIFT_HILL;
        if (el.inverted) placeFlags |= TRACK_PLACE_INVERTED;
        return {
            x: ox * TILE_SIZE + piece.x,
            y: oy * TILE_SIZE + piece.y,
            z: baseZ + piece.z,
            direction: piece.direction,
            ride: rideId,
            trackType: el.type,
            rideType: rideType,
            brakeSpeed: isNumber(el.brakeSpeed) ? el.brakeSpeed : 2,
            colour: isNumber(el.colourScheme) ? el.colourScheme : 0,
            seatRotation: isNumber(el.seatRotation) ? el.seatRotation : 4,
            trackPlaceFlags: placeFlags,
            isFromTrackDesign: true,
            flags: flags,
        };
    }

    /**
     * Runs fn synchronously inside the next game tick. Actions executed there run immediately instead of being
     * queued, which keeps trackplace's isFromTrackDesign flag (lost when a queued action is cloned) and lets a
     * design cross over its own track. Falls back to running now (queued) while the game is paused.
     */
    function inNextTick(fn) {
        return new Promise((resolve, reject) => {
            if (context.paused) {
                Promise.resolve().then(fn).then(resolve, reject);
                return;
            }
            let done = false;
            let sub = null;
            const timer = context.setTimeout(() => {
                if (done) return;
                done = true;
                if (sub) sub.dispose();
                Promise.resolve().then(fn).then(resolve, reject);
            }, 2000);
            sub = context.subscribe('interval.tick', () => {
                if (done) return;
                done = true;
                sub.dispose();
                context.clearTimeout(timer);
                try {
                    resolve(fn());
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Issues an action exactly once and returns a promise for its result. Inside a game tick (unpaused, single
     * player) the game runs it immediately and the callback fires before this returns; otherwise (paused, a
     * multiplayer server or client) the game queues it and the promise resolves when it has run. Never re-issue
     * a queued action: the queued copy still runs.
     */
    function issueAction(name, args) {
        return new Promise(resolve => {
            let done = false;
            let timer = null;
            const finish = res => {
                if (done) return;
                done = true;
                if (timer !== null) context.clearTimeout(timer);
                resolve(res);
            };
            try {
                context.executeAction(name, args, res => finish(res));
            } catch (e) {
                finish({ error: -2, errorMessage: String(e && e.message ? e.message : e) });
            }
            if (!done) {
                timer = context.setTimeout(
                    () => finish({ error: -1, errorMessage: 'Timed out waiting for the game to execute the action.' }),
                    ACTION_TIMEOUT_MS);
            }
        });
    }

    /** Finds the ride object a layout needs: its own vehicle if buildable, else another of the same ride type. */
    function resolveLayoutRide(layout, params) {
        const options = buildableRideOptions().filter(o => o.kind !== 'stall');
        if (params.object !== undefined || params.ride !== undefined || isNumber(params.rideType)) {
            return { option: resolveRideOption(params, ['tracked', 'tower', 'flat', 'maze']), substituted: false };
        }
        const legacy = typeof layout.vehicleObject === 'string' ? layout.vehicleObject.trim().toLowerCase() : null;
        if (legacy) {
            for (const o of options) {
                let obj = null;
                try {
                    obj = objectManager.getObject('ride', o.object);
                } catch (e) {
                    obj = null;
                }
                if (obj && obj.legacyIdentifier && obj.legacyIdentifier.trim().toLowerCase() === legacy) {
                    return { option: o, substituted: false };
                }
            }
        }
        let types = [];
        if (isNumber(layout.rideType)) types = [layout.rideType];
        else if (isNumber(layout.rct2RideType)) types = RCT2_RIDE_TYPE_VARIANTS[layout.rct2RideType] || [layout.rct2RideType];
        const match = options.find(o => types.includes(o.rideType));
        if (match) return { option: match, substituted: !!legacy };
        const typeNames = types.map(t => (RIDE_TYPE_DATA[t] ? RIDE_TYPE_DATA[t][0] : t)).join(' or ');
        fail('This design needs a ' + (typeNames || 'ride type') + (legacy ? ' (vehicle ' + layout.vehicleObject.trim() + ')' : '')
            + ' that this park has not researched or loaded.');
    }

    /** Places the entrances/exits a design specifies; returns problems instead of throwing. */
    /**
     * Station index of the ride's track on tile (x, y) at height z (any height if z is null), or null if there is
     * none. The API only reads the station index of station pieces; other pieces that take entrances (tower and
     * flat ride bases) are matched to the ride's stations by height (tower rides have a bottom and a top station).
     */
    function stationIndexAt(rideId, x, y, z) {
        for (const el of map.getTile(x, y).elements) {
            if (el.type !== 'track' || el.ride !== rideId || (z !== null && el.baseZ !== z)) continue;
            if (STATION_TRACK_TYPES.includes(el.trackType) && isNumber(el.station)) return el.station;
            const match = rideStations(map.getRide(rideId)).find(s => s.station.start && s.station.start.z === el.baseZ);
            return match ? match.index : 0;
        }
        return null;
    }

    function designEntrancePlacements(layout, rideId, ox, oy, baseZ, direction) {
        const out = [];
        for (const e of layout.entrances || []) {
            const r = rotate(e.x, e.y, direction);
            const x = ox + Math.floor(r.x / TILE_SIZE);
            const y = oy + Math.floor(r.y / TILE_SIZE);
            const dir = (direction + e.direction) & 3;
            const z = e.z === null || e.z === undefined ? null : e.z * 8 + baseZ;
            // The station is whatever station the track beside the entrance belongs to. Like the game
            // (TrackDesignPlaceEntrances), skip entrances with no track of the ride at their height beside them.
            const station = stationIndexAt(rideId, x + DIR_DX[dir], y + DIR_DY[dir], z);
            if (station === null) continue;
            const away = dir ^ 2;
            out.push({
                x: x, y: y, direction: dir, station: station, isExit: !!e.isExit, z: z,
                front: { x: x + DIR_DX[away], y: y + DIR_DY[away] },
            });
        }
        return out;
    }

    /** Can an entrance/exit stand on (x, y) at height z, with a path possible on the tile in front of it? */
    function portalSpotOk(tc, x, y, z, frontX, frontY, height) {
        const spot = tc.get(x, y);
        const front = tc.get(frontX, frontY);
        if (!spot || !spot.surface || !front || !front.surface) return false;
        const sandbox = isSandbox();
        if (!sandbox && !spot.surface.owned) return false;
        if (!sandbox && !front.surface.owned && !front.surface.rights) return false;
        if (spot.paths.length || spot.entrances.length || spot.largeScenery) return false;
        if (spot.tracks.some(t => t.z < z + (height || ENTRANCE_CLEARANCE) && t.clearanceZ > z)) return false;
        if (spot.surface.water > z || surfaceTop(spot) > z) return false;
        if (front.surface.water > z) return false;
        if (front.entrances.length || front.largeScenery) return false;
        if (front.tracks.some(t => t.z < z + PATH_CLEARANCE && t.clearanceZ > z)) return false;
        return true;
    }

    /** Pieces that entrances can attach to: station platforms, or a flat ride's / tower's base piece. */
    function portalPieces(walked) {
        return walked.pieces.filter(p => STATION_TRACK_TYPES.includes(p.el.type)
            || (TRACK_SEQUENCE_FLAGS[p.el.type] && TRACK_SEQUENCE_FLAGS[p.el.type].some(f => f & 0x0F)));
    }

    /**
     * The layout's stations, each a list of pieces: the runs of station pieces in track order (a run at the end of
     * the circuit joins the first), or for rides without station pieces the first piece that takes entrances.
     */
    function stationRuns(walked) {
        const runs = [];
        let current = null;
        for (const p of walked.pieces) {
            if (STATION_TRACK_TYPES.includes(p.el.type)) {
                if (!current) {
                    current = [];
                    runs.push(current);
                }
                current.push(p);
            } else {
                current = null;
            }
        }
        const pieces = walked.pieces;
        if (runs.length > 1 && STATION_TRACK_TYPES.includes(pieces[0].el.type)
            && STATION_TRACK_TYPES.includes(pieces[pieces.length - 1].el.type)) {
            runs[0] = runs.pop().concat(runs[0]);
        }
        if (runs.length > 0) return runs;
        const base = portalPieces(walked).slice(0, 1);
        return base.length > 0 ? [base] : [];
    }

    /**
     * Entrance/exit spots beside the layout's stations (used when a layout gives none), each with its z and the
     * index of its station in stationRuns order.
     */
    function stationAttachmentPoints(walked, ox, oy, baseZ) {
        const points = [];
        stationRuns(walked).forEach((run, station) => {
            for (const p of run) {
                const fp = pieceFootprint(p.el.type);
                const tx = ox + Math.floor(p.x / TILE_SIZE);
                const ty = oy + Math.floor(p.y / TILE_SIZE);
                for (const a of attachmentPoints(p.el.type, fp, tx, ty, p.direction)) {
                    a.z = baseZ + p.z;
                    a.station = station;
                    points.push(a);
                }
            }
        });
        return points;
    }

    /**
     * Station-side spots an exit could use (and whether an entrance could, being taller), checked against the map
     * and, before building, against the space the ride's own track will take (`own`).
     */
    function usableStationSpots(tc, spots, own) {
        const free = (a, height) => portalSpotOk(tc, a.x, a.y, a.z, a.front.x, a.front.y, height)
            && !(own && (spanOccupied(own, a.x, a.y, a.z, a.z + height)
                || spanOccupied(own, a.front.x, a.front.y, a.z, a.z + PATH_CLEARANCE)));
        return spots.filter(a => free(a, EXIT_CLEARANCE)).map(a => Object.assign({}, a, { canBeEntrance: free(a, ENTRANCE_CLEARANCE) }));
    }

    /** Stations (indices into stationRuns) that already have one of the portals in `keep` beside them. */
    function coveredStations(allSpots, keep) {
        const stations = [...new Set(allSpots.map(a => a.station))];
        // With a single station, any usable spot of the design's is beside it.
        if (stations.length === 1) return new Set(keep.length > 0 ? stations : []);
        const covered = new Set();
        for (const p of keep) {
            const spot = allSpots.find(a => a.x === p.x && a.y === p.y && a.direction === p.direction
                && (p.z === null || p.z === undefined || a.z === p.z));
            if (spot) covered.add(spot.station);
        }
        return covered;
    }

    /** Does `keep` give the ride an entrance, an exit, and every station one or the other? */
    function portalsComplete(allSpots, keep) {
        const covered = coveredStations(allSpots, keep);
        return keep.some(p => !p.isExit) && keep.some(p => p.isExit) && allSpots.every(a => covered.has(a.station));
    }

    /**
     * Chooses the entrances and exits still missing from the station-side spots of stationAttachmentPoints (`keep`
     * holds the design's own spots that will be used). Like the game requires before a ride can open
     * (RideCheckForEntranceExit), the ride gets an entrance and an exit, and every station at least one of them:
     * stations left without one get an exit. Prefers the open side of a station, where paths have somewhere to go,
     * but only while that still leaves a valid choice. Used both before building (to accept a placement) and
     * after, so the two always agree. Returns null when there is no valid choice.
     */
    function choosePortalSpots(tc, allSpots, field, keep, own) {
        const stations = [...new Set(allSpots.map(a => a.station))];
        const covered = coveredStations(allSpots, keep);
        const needEntrance = !keep.some(p => !p.isExit);
        const needExit = !keep.some(p => p.isExit);
        if (!needEntrance && !needExit && stations.every(st => covered.has(st))) return { extraExits: [] };
        const taken = new Set(keep.map(p => tileKey(p.x, p.y)));
        const spots = usableStationSpots(tc, allSpots, own);
        const apart = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        // `want` is 'pair', 'entrance' or 'exit'.
        const pick = (list, want) => {
            if (list.length === 0) return null;
            const ranked = rankAttachments(tc, list, field, list[0].z, EXIT_CLEARANCE);
            if (want === 'pair') return chooseEntranceAndExit(ranked);
            if (want === 'entrance') {
                const exit = keep.find(p => p.isExit);
                const usable = p => !p.frontHasPath && p.canBeEntrance !== false;
                const entrance = ranked.find(p => usable(p) && apart(p, exit) >= 2) || ranked.find(usable);
                return entrance ? { entrance: entrance } : null;
            }
            const entrance = keep.find(p => !p.isExit);
            const exit = (entrance && ranked.find(p => apart(p, entrance) >= 2 && apart(p.front, entrance.front || entrance) >= 2))
                || ranked[0];
            return { exit: exit };
        };
        const pickOpen = (list, want) => {
            for (const need of [3, 2]) {
                const choice = pick(list.filter(a => pathExits(tc, a.front.x, a.front.y, a.z, a.x, a.y, own) >= need), want);
                if (choice) return choice;
            }
            return pick(list, want);
        };
        const freeAt = st => spots.filter(a => a.station === st && !taken.has(tileKey(a.x, a.y)));
        // The missing entrance and/or exit go to the first station with room for them.
        let choice = { extraExits: [] };
        if (needEntrance || needExit) {
            const want = needEntrance && needExit ? 'pair' : (needEntrance ? 'entrance' : 'exit');
            choice = null;
            for (const st of stations) {
                choice = pickOpen(freeAt(st), want);
                if (choice) break;
            }
            if (!choice) return null;
            choice.extraExits = [];
            for (const a of [choice.entrance, choice.exit]) {
                if (!a) continue;
                taken.add(tileKey(a.x, a.y));
                covered.add(a.station);
            }
        }
        for (const st of stations) {
            if (covered.has(st)) continue;
            const extra = pickOpen(freeAt(st), 'exit');
            if (!extra) return null;
            taken.add(tileKey(extra.exit.x, extra.exit.y));
            choice.extraExits.push(extra.exit);
        }
        return choice;
    }

    async function applyLayoutSettings(rideId, layout, option, flags, warnings) {
        const run = async (action, args, what, quiet) => {
            const res = await executeAction(action, Object.assign({ ride: rideId, flags: flags }, args));
            if (res.error !== 0 && !quiet) warnings.push(what + ': ' + describeResult(res));
        };
        const s = layout.settings || {};
        if (isNumber(s.rideMode)) await run('ridesetsetting', { setting: 0, value: s.rideMode }, 'mode');
        if (isNumber(s.numberOfTrains) && s.numberOfTrains > 0) {
            await run('ridesetvehicle', { type: 0, value: s.numberOfTrains, colour: 0 }, 'trains');
        }
        if (isNumber(s.carsPerTrain) && s.carsPerTrain > 0) {
            await run('ridesetvehicle', { type: 1, value: s.carsPerTrain, colour: 0 }, 'cars per train');
        }
        const settings = [['departFlags', 1], ['minWaitingTime', 2], ['maxWaitingTime', 3], ['operationSetting', 4],
            ['liftHillSpeed', 8], ['numCircuits', 9]];
        for (const [key, id] of settings) {
            if (isNumber(s[key]) && (key !== 'numCircuits' || s[key] > 0) && (key !== 'liftHillSpeed' || s[key] > 0)) {
                // Like TrackDesignAction, ignore settings that do not apply to the ride's mode.
                await run('ridesetsetting', { setting: id, value: s[key] }, key, key === 'operationSetting');
            }
        }
        const c = layout.colours || {};
        // The colour scheme first: changing it copies one train's colours to the others, which would overwrite
        // the design's per-train colours if it came last.
        if (isNumber(c.vehicleColourSettings)) {
            await run('ridesetappearance', { type: 6, value: c.vehicleColourSettings, index: 0 }, 'vehicle colour scheme');
        }
        const colourRuns = [];
        (c.track || []).forEach((tc, i) => {
            if (!tc) return;
            ['main', 'additional', 'supports'].forEach((k, t) => {
                if (isNumber(tc[k])) colourRuns.push(run('ridesetappearance', { type: t, value: tc[k], index: i }, 'track colour'));
            });
        });
        (c.vehicles || []).slice(0, 32).forEach((vc, i) => {
            if (!vc) return;
            ['body', 'trim', 'tertiary'].forEach((k, t) => {
                if (isNumber(vc[k])) colourRuns.push(run('ridesetappearance', { type: 3 + t, value: vc[k], index: i }, 'vehicle colour'));
            });
        });
        await Promise.all(colourRuns);
    }

    /** Will this candidate have room for an entrance and an exit (the design's own, or beside the station)? */
    function portalsPossible(tc, layout, cand, z, rideClearance) {
        // Space the layout's own track will take once built: an entrance needs its tile clear for its height and
        // the path in front of it needs headroom (track passing high overhead is fine).
        const own = layoutOccupancy(cand.walked, cand.ox, cand.oy, z, rideClearance);
        const clear = (x, y, ez, fx, fy, isExit) => {
            const height = isExit ? EXIT_CLEARANCE : ENTRANCE_CLEARANCE;
            return !spanOccupied(own, x, y, ez, ez + height) && !spanOccupied(own, fx, fy, ez, ez + PATH_CLEARANCE)
                && portalSpotOk(tc, x, y, ez, fx, fy, height);
        };
        const ents = (layout.entrances || []).map(e => {
            const r = rotate(e.x, e.y, cand.direction);
            const x = cand.ox + Math.floor(r.x / TILE_SIZE);
            const y = cand.oy + Math.floor(r.y / TILE_SIZE);
            const dir = (cand.direction + e.direction) & 3;
            const known = e.z !== null && e.z !== undefined;
            const ez = known ? e.z * 8 + z : z;
            const front = { x: x + DIR_DX[dir ^ 2], y: y + DIR_DY[dir ^ 2] };
            return {
                x: x, y: y, z: known ? ez : null, direction: dir, front: front, isExit: !!e.isExit,
                ok: clear(x, y, ez, front.x, front.y, !!e.isExit),
            };
        });
        const keep = ents.filter(e => e.ok);
        if (portalPieces(cand.walked).length === 0) {
            return (keep.some(e => !e.isExit) && keep.some(e => e.isExit)) || ents.length === 0 || ents.every(e => e.ok);
        }
        // Otherwise the same choice the build will make beside the stations must exist.
        return choosePortalSpots(tc, stationAttachmentPoints(cand.walked, cand.ox, cand.oy, z), null, keep, own) !== null;
    }

    /** Origins for rides that must run on water: every track block over water, near the requested spot. */
    async function addWaterCandidates(tc, elements, layout, params, directions, candidates) {
        const water = await waterTiles();
        if (water.length === 0) fail('This ride must be built on water and the park has none.');
        let tx;
        let ty;
        if (params.near && params.near !== 'water' && isNumber(params.near.x)) {
            tx = params.near.x;
            ty = params.near.y;
        } else {
            tx = water.reduce((a, w) => a + w[0], 0) / water.length;
            ty = water.reduce((a, w) => a + w[1], 0) / water.length;
        }
        const radius = optInt(params, 'radius', 40);
        const nearby = water.filter(w => Math.abs(w[0] - tx) + Math.abs(w[1] - ty) <= radius * 2)
            .sort((a, b) => (Math.abs(a[0] - tx) + Math.abs(a[1] - ty)) - (Math.abs(b[0] - tx) + Math.abs(b[1] - ty)));
        for (const d of directions) {
            const walked = walkLayout(elements, d);
            const shape = layoutTiles(walked, layout.entrances, d);
            const trackTiles = layoutTiles(walked, [], d).tiles;
            for (const [wx, wy] of nearby) {
                const allWet = trackTiles.every(t => {
                    const info = tc.get(wx + t.x, wy + t.y);
                    return info && info.surface && info.surface.water > info.surface.z;
                });
                if (!allWet) continue;
                candidates.push({ walked: walked, shape: shape, direction: d, ox: wx, oy: wy,
                    site: { distanceToTarget: Math.abs(wx - tx) + Math.abs(wy - ty), distanceToPath: null } });
                if (candidates.length >= 40) return;
            }
            await nextTick();
        }
    }

    /** mazeplacetrack arguments for every tile of a maze design placed at (ox, oy, z) facing `direction`. */
    function mazeTileArgs(layout, rideId, ox, oy, z, direction, flags) {
        const rol16 = (v, n) => {
            n &= 15;
            return ((v << n) | (v >>> (16 - n))) & 0xFFFF;
        };
        return layout.mazeElements.map(m => {
            const r = rotate(m.x * TILE_SIZE, m.y * TILE_SIZE, direction);
            return {
                x: ox * TILE_SIZE + r.x, y: oy * TILE_SIZE + r.y, z: z, ride: rideId,
                mazeEntry: rol16(m.entry, direction * 4), flags: flags,
            };
        });
    }

    /** Lowest height (a multiple of 16, as mazes need) above the terrain under every maze tile. */
    function mazeBaseZ(tc, layout, ox, oy, direction) {
        let z = 0;
        for (const args of mazeTileArgs(layout, -1, ox, oy, 0, direction, 0)) {
            const info = tc.get(args.x / TILE_SIZE, args.y / TILE_SIZE);
            if (!info || !info.surface) return null;
            z = Math.max(z, surfaceTop(info), info.surface.water || 0);
        }
        return Math.ceil(z / 16) * 16;
    }

    /** Do a maze design's own entrance and exit spots work at this placement? (Mazes have no other spots.) */
    function mazePortalsOk(tc, layout, ox, oy, z, direction) {
        const spots = (layout.entrances || []).map(e => {
            const r = rotate(e.x, e.y, direction);
            const x = ox + Math.floor(r.x / TILE_SIZE);
            const y = oy + Math.floor(r.y / TILE_SIZE);
            const away = ((direction + e.direction) & 3) ^ 2;
            return { isExit: !!e.isExit, ok: portalSpotOk(tc, x, y, z, x + DIR_DX[away], y + DIR_DY[away],
                e.isExit ? EXIT_CLEARANCE : ENTRANCE_CLEARANCE) };
        });
        return spots.some(p => p.ok && !p.isExit) && spots.some(p => p.ok && p.isExit);
    }

    async function placeMaze(tc, layout, rideId, ox, oy, z, direction, flags) {
        let cost = 0;
        for (const args of mazeTileArgs(layout, rideId, ox, oy, z, direction, flags)) {
            const res = await executeAction('mazeplacetrack', args);
            if (res.error !== 0) fail('Could not place maze tile: ' + describeResult(res));
            cost += res.cost || 0;
        }
        return cost;
    }

    /**
     * Places a track layout (decoded track design or custom layout). Returns the summary; throws on failure
     * after demolishing the partially built ride.
     * layout: { name, trackElements[], entrances[], mazeElements[], settings{}, colours{}, entranceStyle,
     *           vehicleObject (DAT name), rct2RideType | rideType }
     */
    async function buildLayout(layout, params, resolvedOption) {
        ensureCanBuild(params);
        checkStatusParam(params);
        const isMaze = Array.isArray(layout.mazeElements) && layout.mazeElements.length > 0;
        const elements = layout.trackElements || [];
        if (!isMaze && elements.length === 0) fail('The layout has no track pieces.');
        if (elements.length > 3000) fail('The layout has too many pieces.');
        // Callers that already checked the layout against a ride pass it, so the same ride is built.
        const { option, substituted } = resolvedOption ? { option: resolvedOption, substituted: false } : resolveLayoutRide(layout, params);
        const flags = buildFlags(params);
        const tc = new TileCache();

        // Candidate origins and directions.
        const directions = isNumber(params.direction) ? [params.direction & 3] : [0, 1, 2, 3];
        const candidates = [];
        const onWater = rideTypeInfo(option.rideType).has('trackMustBeOnWater');
        if (onWater && !(isNumber(params.x) && isNumber(params.y))) {
            await addWaterCandidates(tc, elements, layout, params, directions, candidates);
        }
        for (const d of (onWater && candidates.length > 0) ? [] : directions) {
            const walked = isMaze ? { pieces: [], end: null } : walkLayout(elements, d);
            const shape = isMaze
                ? layoutTiles({ pieces: [] }, layout.mazeElements.map(m => ({ x: m.x * TILE_SIZE, y: m.y * TILE_SIZE })).concat(
                    (layout.entrances || []).map(e => ({ x: e.x, y: e.y }))), d)
                : layoutTiles(walked, layout.entrances, d);
            const width = shape.maxX - shape.minX + 1;
            const length = shape.maxY - shape.minY + 1;
            if (isNumber(params.x) && isNumber(params.y)) {
                candidates.push({ walked: walked, shape: shape, direction: d,
                    ox: Math.floor(params.x) - shape.minX, oy: Math.floor(params.y) - shape.minY });
            } else {
                const sites = await findSites(tc, {
                    width: width, length: length, margin: 1, near: params.near || 'water',
                    radius: optInt(params, 'radius', 16), maxResults: 4, anyTerrain: true,
                });
                for (const site of sites) {
                    candidates.push({ walked: walked, shape: shape, direction: d, site: site,
                        ox: site.x - shape.minX, oy: site.y - shape.minY });
                }
            }
        }
        if (candidates.length === 0) {
            fail('No free area big enough for this layout was found near ' + (params.near === undefined || params.near === 'water'
                ? 'water' : JSON.stringify(params.near)) + '. Try a larger radius or another location.');
        }
        candidates.sort((a, b) => (a.site ? a.site.distanceToTarget : 0) - (b.site ? b.site.distanceToTarget : 0));

        const rideId = await createRide(option, Object.assign({}, params, {
            stationStyle: params.stationStyle !== undefined ? params.stationStyle
                : (isNumber(layout.entranceStyle) && STATION_STYLES[layout.entranceStyle]
                    && loadedObjects('station').some(o => o.identifier === STATION_STYLES[layout.entranceStyle])
                    ? STATION_STYLES[layout.entranceStyle] : undefined),
        }), flags);
        const warnings = [];
        try {
            // Validate each candidate with the game's own queries (trying a few heights, as the UI does).
            let chosen = null;
            const reasons = [];
            const debugInfo = [];
            for (const cand of candidates.slice(0, 16)) {
                const z0 = isMaze ? mazeBaseZ(tc, layout, cand.ox, cand.oy, cand.direction) : layoutBaseZ(tc, cand.walked, cand.ox, cand.oy);
                if (z0 === null) continue;
                const step = isMaze ? 16 : 8;
                const startZ = isNumber(params.z) ? Math.ceil(Math.floor(params.z) / step) * step : z0;
                for (let attempt = 0; attempt < (isNumber(params.z) ? 1 : (isMaze ? 2 : 7)) && !chosen; attempt++) {
                    const z = startZ + attempt * step;
                    let ok = true;
                    let cost = 0;
                    if (isMaze) {
                        for (const args of mazeTileArgs(layout, rideId, cand.ox, cand.oy, z, cand.direction, flags)) {
                            const r = queryActionSync('mazeplacetrack', args);
                            if (r.error !== 0) {
                                ok = false;
                                reasons.push(describeResult(r));
                                break;
                            }
                            cost += r.cost || 0;
                        }
                        if (ok && !mazePortalsOk(tc, layout, cand.ox, cand.oy, z, cand.direction)) {
                            ok = false;
                            reasons.push('no usable spot for the entrance and exit');
                        }
                    } else {
                        for (const p of cand.walked.pieces) {
                            const r = queryActionSync('trackplace', trackPlaceArgs(rideId, option.rideType, p, cand.ox, cand.oy, z, flags));
                            if (r.error !== 0) {
                                ok = false;
                                reasons.push(describeResult(r));
                                break;
                            }
                            cost += r.cost || 0;
                        }
                    }
                    if (ok && !isMaze && !portalsPossible(tc, layout, cand, z, rideTypeInfo(option.rideType).clearance)) {
                        ok = false;
                        reasons.push('no usable spot for the entrance and exit');
                    }
                    if (params.debug) debugInfo.push({ ox: cand.ox, oy: cand.oy, direction: cand.direction, z: z, ok: ok, last: reasons[reasons.length - 1] });
                    if (ok) chosen = Object.assign({ z: z, estimatedCost: cost }, cand);
                }
                if (chosen) break;
            }
            if (!chosen) {
                fail('The game rejected every candidate placement for this layout.', {
                    reasons: Array.from(new Set(reasons)).slice(0, 6),
                    candidates: params.debug ? debugInfo : undefined,
                });
            }

            const summaryBase = {
                rideId: rideId,
                ride: option.name,
                design: layout.name || null,
                pieces: isMaze ? layout.mazeElements.length : elements.length,
                origin: { x: chosen.ox, y: chosen.oy, z: chosen.z },
                direction: chosen.direction,
                area: {
                    x1: chosen.ox + chosen.shape.minX, y1: chosen.oy + chosen.shape.minY,
                    x2: chosen.ox + chosen.shape.maxX, y2: chosen.oy + chosen.shape.maxY,
                },
            };
            if (substituted) summaryBase.vehicleSubstituted = 'design vehicle ' + layout.vehicleObject.trim() + ' not available';
            if (chosen.site) summaryBase.site = { distanceToTarget: chosen.site.distanceToTarget, distanceToPath: chosen.site.distanceToPath };
            if (params.dryRun) {
                await demolishRide(rideId, flags);
                return Object.assign({ dryRun: true, validated: true, estimatedCost: chosen.estimatedCost,
                    estimatedCostFormatted: formatMoney(chosen.estimatedCost),
                    note: 'The placement passed the game\'s checks; nothing was built.' }, summaryBase);
            }

            // Issue the track inside one game tick so it executes atomically and keeps isFromTrackDesign (which
            // lets a design cross over its own track). When paused or in multiplayer the game queues the pieces
            // instead (dropping that flag); either way each piece is issued once and its result awaited.
            let spent = 0;
            if (isMaze) {
                spent += await placeMaze(tc, layout, rideId, chosen.ox, chosen.oy, chosen.z, chosen.direction, flags);
            } else {
                const pending = await inNextTick(() => chosen.walked.pieces.map(p =>
                    issueAction('trackplace', trackPlaceArgs(rideId, option.rideType, p, chosen.ox, chosen.oy, chosen.z, flags))));
                const results = await Promise.all(pending);
                const failed = results.findIndex(r => !r || r.error !== 0);
                if (failed >= 0) {
                    fail('Track piece ' + (failed + 1) + ' (' + TRACK_TYPE_NAMES[elements[failed].type] + ') could not be built: '
                        + describeResult(results[failed]));
                }
                spent += results.reduce((sum, r) => sum + (r.cost || 0), 0);
            }

            // Entrances and exits: the design's own spots where usable, otherwise spots beside the station.
            let portals = [];
            const tcNow = new TileCache();
            if ((layout.entrances || []).length > 0) {
                portals = designEntrancePlacements(layout, rideId, chosen.ox, chosen.oy, chosen.z, chosen.direction)
                    .filter(p => portalSpotOk(tcNow, p.x, p.y, p.z === null ? chosen.z : p.z, p.front.x, p.front.y,
                        p.isExit ? EXIT_CLEARANCE : ENTRANCE_CLEARANCE));
            }
            const stationSpots = stationAttachmentPoints(chosen.walked, chosen.ox, chosen.oy, chosen.z);
            if (isMaze && (!portals.some(p => !p.isExit) || !portals.some(p => p.isExit))) {
                warnings.push('the maze design\'s entrance or exit spot was not usable; add it with execute_game_action');
            } else if (!isMaze && !portalsComplete(stationSpots, portals)) {
                const keep = portals;
                const entrances = await getParkEntrances();
                const goalTiles = entrances.map(e => [e.x, e.y]);
                for (const key of computeParkNetwork(new TileCache(), entrances)) {
                    const [nx, ny] = key.split(',');
                    goalTiles.push([+nx, +ny]);
                }
                const field = distanceField(tc, goalTiles);
                // The same choice portalsPossible checked before building, now against the built track.
                const choice = choosePortalSpots(tcNow, stationSpots, field, keep, null);
                if (!choice) fail('No room beside the station for an entrance and exit.');
                const station = a => {
                    const index = stationIndexAt(rideId, a.rideTile.x, a.rideTile.y, a.z);
                    return index === null ? 0 : index;
                };
                portals = keep.slice();
                if (choice.entrance) {
                    const a = choice.entrance;
                    portals.push({ x: a.x, y: a.y, direction: a.direction, station: station(a), isExit: false });
                }
                for (const a of (choice.exit ? [choice.exit] : []).concat(choice.extraExits)) {
                    portals.push({ x: a.x, y: a.y, direction: a.direction, station: station(a), isExit: true });
                }
                if ((layout.entrances || []).length > 0 && (choice.entrance || choice.exit)) {
                    warnings.push('placed ' + (keep.length ? 'some' : 'the') + ' entrance/exit beside the station instead of where the design had them');
                }
                if ((layout.entrances || []).length > 0 && choice.extraExits.length > 0) {
                    warnings.push('added an exit to ' + choice.extraExits.length + ' station(s) the design left without an entrance or exit');
                }
            }
            for (const p of portals) {
                const res = await executeAction('rideentranceexitplace', {
                    x: p.x * TILE_SIZE, y: p.y * TILE_SIZE, direction: p.direction, ride: rideId, station: p.station,
                    isExit: p.isExit, flags: flags,
                });
                if (res.error !== 0) warnings.push((p.isExit ? 'exit' : 'entrance') + ' at ' + p.x + ',' + p.y + ': ' + describeResult(res));
                else spent += res.cost || 0;
            }

            const settingsLayout = Object.assign({}, layout, { settings: Object.assign({}, layout.settings || {}) });
            if (isNumber(params.trains)) settingsLayout.settings.numberOfTrains = Math.floor(params.trains);
            if (isNumber(params.carsPerTrain)) settingsLayout.settings.carsPerTrain = Math.floor(params.carsPerTrain);
            await applyLayoutSettings(rideId, settingsLayout, option, flags, warnings);
            const summary = Object.assign({ built: true }, summaryBase);
            const ride = map.getRide(rideId);
            summary.name = ride.name;
            const wantedName = typeof params.name === 'string' && params.name ? params.name : layout.name;
            if (wantedName) {
                for (let n = 1; n <= 9; n++) {
                    const candidateName = n === 1 ? wantedName : wantedName + ' ' + n;
                    const r = await executeAction('ridesetname', { ride: rideId, name: candidateName, flags: flags });
                    if (r.error === 0) {
                        summary.name = candidateName;
                        break;
                    }
                }
            }
            summary.stations = rideStations(ride).map(({ index, station }) => ({
                index: index,
                entrance: station.entrance ? { x: station.entrance.x / TILE_SIZE, y: station.entrance.y / TILE_SIZE } : null,
                exit: station.exit ? { x: station.exit.x / TILE_SIZE, y: station.exit.y / TILE_SIZE } : null,
            }));
            log('Built ' + summary.name + ' (' + summary.pieces + ' pieces)');

            if (params.connectPaths !== false && summary.stations.some(s => s.entrance)) {
                // A queue to every entrance and a path from every exit; the first station's are reported as
                // paths.queue and paths.exit, any others under paths.otherStations.
                summary.paths = {};
                for (const st of summary.stations) {
                    if (!st.entrance && !st.exit) continue;
                    const pathParams = { rideId: rideId, station: st.index, allowWhilePaused: params.allowWhilePaused };
                    const out = Object.keys(summary.paths).length === 0 ? summary.paths : { station: st.index };
                    if (st.entrance) {
                        try {
                            const r = await methods.build_ride_queue(pathParams);
                            out.queue = { built: r.built, cost: r.costFormatted, reachesNetwork: r.queueReachesParkNetwork };
                            spent += r.cost || 0;
                        } catch (e) {
                            out.queue = 'failed: ' + e.message;
                        }
                    }
                    if (st.exit) {
                        try {
                            const r = await methods.connect_ride_exit(pathParams);
                            out.exit = r.alreadyConnected ? 'already connected'
                                : { built: r.built, cost: r.costFormatted, connected: r.exitConnected };
                            spent += r.cost || 0;
                        } catch (e) {
                            out.exit = 'failed: ' + e.message;
                        }
                    }
                    if (out !== summary.paths) (summary.paths.otherStations = summary.paths.otherStations || []).push(out);
                }
            }
            // Tracked rides start testing unless told otherwise, so the game measures their ratings.
            const kind = rideTypeInfo(option.rideType).kind;
            const status = params.status || (params.open ? 'open' : (kind === 'tracked' || kind === 'tower' ? 'testing' : null));
            await applyRideSettings(rideId, Object.assign({}, params, { status: status, open: false }), flags, summary);
            if (warnings.length > 0) summary.warnings = warnings;
            summary.totalCost = spent;
            summary.totalCostFormatted = formatMoney(spent);
            return summary;
        } catch (e) {
            await demolishRide(rideId, flags);
            throw e;
        }
    }

    // ------------------------------------------------------------------
    // Roller coaster generator
    // ------------------------------------------------------------------

    /** Small seeded random number generator (mulberry32), so a design can be repeated from its seed. */
    function makeRng(seed) {
        let a = seed >>> 0;
        const next = () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        return {
            next: next,
            int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
            pick: list => list[Math.floor(next() * list.length)],
            chance: p => next() < p,
        };
    }

    function shuffle(rng, list) {
        const out = list.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(rng.next() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    function mirrorPieceName(name) {
        return name.replace(/left|Left|right|Right/g, m => ({ left: 'right', Left: 'Right', right: 'left', Right: 'Left' })[m]);
    }

    const repeat = (name, n) => Array.from({ length: Math.max(0, n) }, () => name);

    // Energy model, in z units. A train's "energy" is the height it could still climb to: a chain lift sets it to
    // the top of the lift, friction and drag take some away per tile, and crests must stay below it by a margin.
    // Its speed head (energy minus current height) stands in for speed: measured top speeds follow about
    // 3.2 * sqrt(head) mph. The game's drag grows with speed squared over the train's mass (Vehicle.cpp,
    // GetAccelerationDecrease2), so losses grow with the head and are larger for light trains. Calibrated with
    // test runs in the game: heavy trains (~4000 mass) cleared hills nearly as high as their lift after ~35 tiles
    // (crawling over the top, which rates badly, hence the crest margin), a vertical loop after a 144 lift but not
    // after 112, and corkscrews after an 80 lift; a constant loss of 0.5 per tile let long layouts stall, 1.5 never
    // did. Inversion crests are the highest track block, which sits above the rails, so their margin is negative.
    const COASTER_CREST_MARGIN = 8;
    const COASTER_INVERSION_MARGIN = -12;
    const coasterLoss = (head, tiles, massFactor) => (0.2 + 0.006 * Math.max(0, head) * massFactor) * tiles;

    /**
     * Fastest a train without upstop wheels may take a piece (as a speed head), or Infinity. Such cars leave the
     * track when vertical G drops below -0.45 on a climb (-0.40 for non-bobsleigh cars) or -0.80 otherwise, and
     * non-bobsleigh ones also above 1.5 lateral G (Vehicle::upstopCheck); G = speed * 980 / factor, speed in game
     * units (Vehicle::GetGForces). Kept well inside those limits (vertical G above -0.2, lateral below 1.2).
     */
    function derailHeadLimit(type, noUpstops) {
        if (!noUpstops) return Infinity;
        const factors = TRACK_G_FACTORS[type] || [0, 0];
        let speed = Infinity;
        if (factors[0]) speed = Math.min(speed, (90 + 20) * factors[0] / 980);
        if (factors[1] && noUpstops === 1) speed = Math.min(speed, 120 * factors[1] / 980);
        return speed === Infinity ? Infinity : speedHead(speed * GAME_SPEED_TO_MPH);
    }
    const COASTER_LIFT_EXIT_ENERGY = 8;
    const COASTER_STATION_ENERGY = 8;
    // Brake speed in the game's track speed unit (about 2.25 mph each; stored in steps of 2): 6 is about 13.5 mph.
    const COASTER_BRAKE_SPEED = 6;
    const GAME_SPEED_TO_MPH = 2.25;
    const COASTER_METRES_PER_TILE = 4.5;
    const speedHead = mph => Math.round((mph / 3.2) * (mph / 3.2));

    /**
     * A track drafted piece by piece in layout coordinates: the station starts on tile (0, 0) heading in
     * direction 0, z is relative to the station. Pieces that hit earlier track (using the game's clearances),
     * leave the bounds, go below the station or climb higher than the train could are refused.
     */
    class TrackDraft {
        constructor(types, rideClearance, bounds, maxZ, massFactor, noUpstops) {
            this.types = types;
            this.massFactor = massFactor || 1;
            this.noUpstops = noUpstops || 0;
            this.rideClearance = rideClearance;
            this.bounds = bounds;
            this.maxZ = maxZ;
            this.els = [];
            this.history = [];
            this.occ = new Map();
            this.x = 0;
            this.y = 0;
            this.z = 0;
            this.rot = 0;
            this.energy = COASTER_STATION_ENERGY;
            this.peak = 0;
            this.inversions = 0;
            this.length = 0;
            this.drops = 0;
            this.dropping = false;
            this.airtime = 0;
            this.firstDrop = 0;
            this.liftHeight = 0;
            this.maxHead = 0;
            this.turnScale = this.has(['flatToLeftBank', 'bankedLeftQuarterTurn5Tiles']) ? 1 : 2.5;
            this.refusals = {};
        }

        has(names) {
            return names.every(n => this.types.has(n));
        }

        head() {
            return this.energy - this.z;
        }

        refuse(name, reason) {
            const key = name + ': ' + reason;
            this.refusals[key] = (this.refusals[key] || 0) + 1;
            return false;
        }

        /** Appends pieces by name, all or nothing. */
        add(names, chain) {
            const mark = this.els.length;
            for (const n of names) {
                if (!this.push(n, chain)) {
                    this.rewind(mark);
                    return false;
                }
            }
            return true;
        }

        push(name, chain) {
            const type = this.types.get(name);
            if (type === undefined) return this.refuse(name, 'not available');
            const seg = trackSegment(type);
            if (!seg || (seg.beginDirection & 4) || (seg.endDirection & 4)) return this.refuse(name, 'diagonal');
            if (chain && !seg.allowsChainLift) return this.refuse(name, 'no chain');
            const last = this.els.length > 0 ? trackSegment(this.els[this.els.length - 1].type) : null;
            if (last && (last.endSlope !== seg.beginSlope || last.endBank !== seg.beginBank)) return this.refuse(name, 'join');
            const placeZ = this.z - seg.beginZ;
            const spans = [];
            let top = -Infinity;
            for (let i = 0; i < seg.blocks.length; i++) {
                const b = seg.blocks[i];
                const r = rotate(b.x, b.y, this.rot);
                const tx = Math.floor((this.x + r.x) / TILE_SIZE);
                const ty = Math.floor((this.y + r.y) / TILE_SIZE);
                const bounds = this.bounds;
                if (tx < bounds.minX || tx > bounds.maxX || ty < bounds.minY || ty > bounds.maxY) return this.refuse(name, 'bounds');
                const bz = placeZ + b.z;
                if (bz < 0) return this.refuse(name, 'underground');
                const span = blockSpan(type, i, bz, this.rideClearance);
                if (span.high > this.maxZ) return this.refuse(name, 'too high');
                if (spanOccupied(this.occ, tx, ty, span.low, span.high)) return this.refuse(name, 'collision');
                spans.push({ key: tileKey(tx, ty), low: span.low, high: span.high });
                top = Math.max(top, bz);
            }
            const off = rotate(seg.endX, seg.endY, this.rot);
            const rot = (this.rot + seg.endDirection - seg.beginDirection) & 3;
            const x = this.x + off.x + DIR_DX[rot] * TILE_SIZE;
            const y = this.y + off.y + DIR_DY[rot] * TILE_SIZE;
            const z = this.z - seg.beginZ + seg.endZ;
            const inverts = seg.beginBank === 15 || seg.endBank === 15 || seg.isInversion;
            // Cars without upstop wheels fly off crests and tight turns taken too fast; judge by the fastest
            // point of the piece (its lowest).
            if (this.noUpstops) {
                const lowest = Math.min(this.z, z, placeZ + Math.min(...seg.blocks.map(b => b.z)));
                if (this.energy - lowest > derailHeadLimit(type, this.noUpstops)) return this.refuse(name, 'would derail');
            }
            let energy = this.energy;
            const crest = Math.max(top, z);
            if (chain) {
                energy = Math.max(energy, z + COASTER_LIFT_EXIT_ENERGY);
            } else if (crest > this.z && crest > energy - (inverts ? COASTER_INVERSION_MARGIN : COASTER_CREST_MARGIN)) {
                return this.refuse(name, 'not enough speed');
            }
            const tiles = (seg.subLength || 32) / 32;
            energy -= coasterLoss(this.energy - this.z, tiles, this.massFactor);
            if (STATION_TRACK_TYPES.includes(type)) energy = Math.max(energy, z + COASTER_STATION_ENERGY);
            if (name === 'brakes') energy = Math.min(energy, z + speedHead(COASTER_BRAKE_SPEED * GAME_SPEED_TO_MPH));

            this.history.push({
                x: this.x, y: this.y, z: this.z, rot: this.rot, energy: this.energy, peak: this.peak,
                inversions: this.inversions, length: this.length, drops: this.drops, dropping: this.dropping,
                airtime: this.airtime, maxHead: this.maxHead, spans: spans,
            });
            for (const s of spans) {
                if (!this.occ.has(s.key)) this.occ.set(s.key, []);
                this.occ.get(s.key).push(s);
            }
            this.els.push({
                type: type, chain: !!chain, inverted: false, brakeSpeed: name === 'brakes' ? COASTER_BRAKE_SPEED : 2,
                seatRotation: 4, colourScheme: 0, station: 0,
            });
            // Drops as the game counts them (roughly): each new run of downward-pitched track. Helixes descend
            // while level, which the game does not count as a drop (or airtime).
            const descending = !seg.isHelix && (z < this.z || seg.beginSlope === 6 || seg.beginSlope === 8);
            if (descending && !this.dropping) {
                this.drops++;
                // Going over a crest with speed to spare gives the negative G (airtime) some ride types need.
                if (last && last.endSlope === 0 && this.head() >= 32 && !inverts) this.airtime++;
            }
            this.dropping = descending;
            this.x = x;
            this.y = y;
            this.z = z;
            this.rot = rot;
            this.energy = energy;
            this.peak = Math.max(this.peak, crest);
            this.maxHead = Math.max(this.maxHead, energy - Math.min(z, placeZ + Math.min(...seg.blocks.map(b => b.z))));
            if (seg.endBank === 15 && seg.beginBank !== 15) this.inversions++;
            if (seg.isInversion && seg.beginBank !== 15 && seg.endBank !== 15) this.inversions++;
            this.length += tiles;
            return true;
        }

        rewind(count) {
            while (this.els.length > count) {
                this.els.pop();
                const h = this.history.pop();
                for (const s of h.spans) {
                    const list = this.occ.get(s.key);
                    list.splice(list.indexOf(s), 1);
                    if (list.length === 0) this.occ.delete(s.key);
                }
                Object.assign(this, {
                    x: h.x, y: h.y, z: h.z, rot: h.rot, energy: h.energy, peak: h.peak, inversions: h.inversions,
                    length: h.length, drops: h.drops, dropping: h.dropping, airtime: h.airtime, maxHead: h.maxHead,
                });
            }
        }
    }

    // Fastest a turn may be entered (speed head, z units) before its lateral G gets uncomfortable.
    // (A head of 200 is about 45 mph.)
    const TURN_SPEED_LIMITS = {
        leftQuarterTurn1Tile: 16, leftQuarterTurn3Tiles: 36, leftQuarterTurn5Tiles: 64, sBendLeft: 80,
        leftBankedQuarterTurn3Tiles: 110, bankedLeftQuarterTurn5Tiles: 220, leftHalfBankedHelixDownSmall: 110,
        leftHalfBankedHelixDownLarge: 220, leftQuarterBankedHelixLargeDown: 220, leftQuarterTurn3TilesDown25: 28,
        leftQuarterTurn5TilesDown25: 56, leftBankedQuarterTurn3TileDown25: 90, leftBankedQuarterTurn5TileDown25: 160,
        leftQuarterTurn3TilesUp25: 72, leftBankedQuarterTurn3TileUp25: 140, leftQuarterTurn5TilesUp25: 110,
        leftBankedQuarterTurn5TileUp25: 240,
    };

    /**
     * Fastest entry (speed head) a run of pieces allows: its tightest turn decides. Ride types without banked
     * track (wild mice, suspended and bobsleigh-like rides) are built to take flat turns faster.
     */
    function sequenceSpeedLimit(names, scale) {
        let limit = Infinity;
        for (const n of names) {
            const key = n.replace(/right|Right/g, m => (m === 'right' ? 'left' : 'Left'));
            if (TURN_SPEED_LIMITS[key] !== undefined) limit = Math.min(limit, TURN_SPEED_LIMITS[key] * (scale || 1));
        }
        return limit;
    }

    /** Features a generated coaster is built from. Each starts and ends on flat, unbanked track. */
    function coasterFeatureCatalogue(draft, style) {
        const both = list => list.flatMap(names => [names, names.map(mirrorPieceName)]);
        const usable = list => list.filter(names => draft.has(names));
        const intense = style === 'intense';
        const gentle = style === 'gentle';
        return [
            { kind: 'straight', weight: 1, options: () => [['flat'], ['flat', 'flat']] },
            { kind: 'turn', weight: gentle ? 4 : 2, options: () => usable(both([['leftQuarterTurn5Tiles'], ['leftQuarterTurn3Tiles'],
                ['leftQuarterTurn1Tile']])) },
            { kind: 'banked turn', weight: gentle ? 2 : 4, options: () => usable(both([
                ['flatToLeftBank', 'bankedLeftQuarterTurn5Tiles', 'leftBankToFlat'],
                ['flatToLeftBank', 'leftBankedQuarterTurn3Tiles', 'leftBankToFlat']])) },
            { kind: 's-bend', weight: 1, options: () => usable(both([['sBendLeft']])) },
            { kind: 'hill', weight: 3, airtime: true, options: rng => usable([0, 1, 2, 3].map(k => ['flatToUp25'].concat(repeat('up25', k),
                ['up25ToFlat', 'flatToDown25'], repeat('down25', k + rng.int(0, 1)), ['down25ToFlat']))) },
            { kind: 'drop', weight: 2, descends: true, options: () => usable([0, 1, 2, 3, 4].map(k =>
                ['flatToDown25'].concat(repeat('down25', k), ['down25ToFlat']))) },
            { kind: 'steep drop', weight: gentle ? 0 : 2, descends: true, options: () => usable([0, 1].map(k =>
                ['flatToDown25', 'down25ToDown60'].concat(repeat('down60', k), ['down60ToDown25', 'down25ToFlat']))) },
            { kind: 'turning drop', weight: 3, descends: true, options: () => usable(both([
                ['flatToDown25', 'leftQuarterTurn5TilesDown25', 'down25ToFlat'],
                ['flatToDown25', 'leftQuarterTurn3TilesDown25', 'down25ToFlat'],
                ['flatToDown25', 'down25ToLeftBankedDown25', 'leftBankedQuarterTurn5TileDown25', 'leftBankedDown25ToDown25', 'down25ToFlat'],
                ['flatToDown25', 'down25ToLeftBankedDown25', 'leftBankedQuarterTurn3TileDown25', 'leftBankedDown25ToDown25', 'down25ToFlat']])) },
            { kind: 'helix', weight: 2, descends: true, options: () => usable(both([
                ['flatToLeftBank', 'leftHalfBankedHelixDownLarge', 'leftBankToFlat'],
                ['flatToLeftBank', 'leftHalfBankedHelixDownLarge', 'leftHalfBankedHelixDownLarge', 'leftBankToFlat'],
                ['flatToLeftBank', 'leftHalfBankedHelixDownSmall', 'leftHalfBankedHelixDownSmall', 'leftBankToFlat'],
                ['flatToLeftBank', 'leftQuarterBankedHelixLargeDown', 'leftBankToFlat']])) },
            { kind: 'climbing turn', weight: 1, options: () => usable(both([
                ['flatToUp25', 'leftQuarterTurn3TilesUp25', 'up25ToFlat'],
                ['flatToUp25', 'up25ToLeftBankedUp25', 'leftBankedQuarterTurn3TileUp25', 'leftBankedUp25ToUp25', 'up25ToFlat'],
                ['flatToUp25', 'leftQuarterTurn5TilesUp25', 'up25ToFlat']])) },
            { kind: 'vertical loop', weight: gentle ? 0 : (intense ? 4 : 2), inversion: true, options: () => usable(both([
                ['flatToUp25', 'leftVerticalLoop', 'down25ToFlat']])) },
            { kind: 'corkscrew', weight: gentle ? 0 : (intense ? 4 : 2), inversion: true, options: () => usable(both([
                ['leftCorkscrewUp', 'leftCorkscrewDown'], ['leftCorkscrewUp', 'rightCorkscrewDown'],
                ['leftLargeCorkscrewUp', 'leftLargeCorkscrewDown'], ['leftLargeCorkscrewUp', 'rightLargeCorkscrewDown']])) },
        ];
    }

    /** Pieces for a drop of `depth` z ending flat (steep in the middle when allowed and deep enough). */
    function dropPieces(draft, depth, steep) {
        if (depth < 16) return [];
        if (steep && depth >= 80 && draft.has(['down25ToDown60', 'down60', 'down60ToDown25'])) {
            const s = Math.floor((depth - 80) / 64);
            const r = Math.floor((depth - 80 - 64 * s) / 16);
            return ['flatToDown25'].concat(repeat('down25', r), ['down25ToDown60'], repeat('down60', s), ['down60ToDown25', 'down25ToFlat']);
        }
        return ['flatToDown25'].concat(repeat('down25', depth / 16 - 1), ['down25ToFlat']);
    }

    /**
     * Finds pieces that bring the draft back to the start of its station: A* over flat, turning and descending
     * moves, refusing turns taken too fast and anything that would hit the track already drafted.
     */
    function closeCircuit(draft, maxNodes, budget) {
        const macros = [];
        const addMacro = names => {
            if (draft.has(names)) macros.push(names);
        };
        addMacro(['flat']);
        for (const t of [['leftQuarterTurn3Tiles'], ['leftQuarterTurn5Tiles'], ['leftQuarterTurn1Tile'],
            ['flatToLeftBank', 'bankedLeftQuarterTurn5Tiles', 'leftBankToFlat'],
            ['flatToLeftBank', 'leftBankedQuarterTurn3Tiles', 'leftBankToFlat']]) {
            addMacro(t);
            addMacro(t.map(mirrorPieceName));
        }
        for (let k = 0; k <= 4; k++) addMacro(['flatToDown25'].concat(repeat('down25', k), ['down25ToFlat']));
        for (const t of ['leftQuarterTurn3TilesDown25', 'leftQuarterTurn5TilesDown25']) {
            addMacro(['flatToDown25', t, 'down25ToFlat']);
            addMacro(['flatToDown25', mirrorPieceName(t), 'down25ToFlat']);
        }
        addMacro(['brakes']);
        const brakeHead = speedHead(COASTER_BRAKE_SPEED * GAME_SPEED_TO_MPH);
        // Each macro's footprint and end pose from each heading, starting at (0, 0, 0).
        const moves = macros.map(names => [0, 1, 2, 3].map(rot => {
            let x = 0;
            let y = 0;
            let z = 0;
            let r = rot;
            let cost = 0;
            const blocks = [];
            const derail = [];
            for (const n of names) {
                const type = draft.types.get(n);
                const seg = trackSegment(type);
                const placeZ = z - seg.beginZ;
                if (draft.noUpstops) {
                    derail.push({ zLow: Math.min(z, z - seg.beginZ + seg.endZ, placeZ + Math.min(...seg.blocks.map(b => b.z))),
                        limit: derailHeadLimit(type, draft.noUpstops) });
                }
                seg.blocks.forEach((b, i) => {
                    const p = rotate(b.x, b.y, r);
                    const span = blockSpan(type, i, placeZ + b.z + 1024, draft.rideClearance);
                    blocks.push({ dx: Math.floor((x + p.x) / TILE_SIZE), dy: Math.floor((y + p.y) / TILE_SIZE),
                        low: span.low - 1024, high: span.high - 1024, z: placeZ + b.z });
                });
                const off = rotate(seg.endX, seg.endY, r);
                r = (r + seg.endDirection - seg.beginDirection) & 3;
                x += off.x + DIR_DX[r] * TILE_SIZE;
                y += off.y + DIR_DY[r] * TILE_SIZE;
                z += seg.endZ - seg.beginZ;
                cost += (seg.subLength || 32) / 32;
            }
            const brakes = names.length === 1 && names[0] === 'brakes';
            return { names: names, blocks: blocks, dx: x, dy: y, dz: z, rot: r, cost: cost, brakes: brakes, derail: derail,
                limit: sequenceSpeedLimit(names, draft.turnScale), penalty: brakes ? 2 : 0 };
        }));
        const start = { x: draft.x, y: draft.y, z: draft.z, rot: draft.rot, g: 0, e: draft.energy, parent: null, move: null,
            pathOcc: new Map() };
        const h = n => (Math.abs(n.x) + Math.abs(n.y)) / TILE_SIZE + n.z / 16 + (n.rot !== 0 ? 1 : 0);
        start.f = h(start);
        const heap = [start];
        const pushHeap = n => {
            heap.push(n);
            let i = heap.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (heap[p].f <= heap[i].f) break;
                [heap[p], heap[i]] = [heap[i], heap[p]];
                i = p;
            }
        };
        const popHeap = () => {
            const top = heap[0];
            const last = heap.pop();
            if (heap.length > 0) {
                heap[0] = last;
                let i = 0;
                for (;;) {
                    const l = 2 * i + 1;
                    const r = l + 1;
                    let m = i;
                    if (l < heap.length && heap[l].f < heap[m].f) m = l;
                    if (r < heap.length && heap[r].f < heap[m].f) m = r;
                    if (m === i) break;
                    [heap[m], heap[i]] = [heap[i], heap[m]];
                    i = m;
                }
            }
            return top;
        };
        const best = new Map();
        const b = draft.bounds;
        let expanded = 0;
        while (heap.length > 0 && expanded < maxNodes) {
            const node = popHeap();
            if (node.x === 0 && node.y === 0 && node.z === 0 && node.rot === 0 && node.parent) {
                const path = [];
                for (let n = node; n.parent; n = n.parent) path.unshift(n.move.names);
                return path;
            }
            // Speed matters (fast trains may not take tight turns), so states differ by speed band too.
            const head = node.e - node.z;
            const band = head <= 24 ? 0 : head <= 56 ? 1 : head <= 96 ? 2 : 3;
            const key = node.x + ',' + node.y + ',' + node.z + ',' + node.rot + ',' + band;
            if (best.has(key) && best.get(key) <= node.g) continue;
            best.set(key, node.g);
            expanded++;
            // A shared, deterministic budget of expansions (so a seed always gives the same design) plus a time limit
            // that only matters on a very slow machine.
            if (budget) {
                if (budget.used >= budget.max) return null;
                if ((budget.used & 255) === 0 && Date.now() > budget.deadline) {
                    budget.timedOut = true;
                    return null;
                }
                budget.used++;
            }
            if (!node.pathOcc) {
                // Space taken by the closing path so far, so it cannot cross itself.
                node.pathOcc = new Map(node.parent.pathOcc);
                const pbx = Math.floor(node.parent.x / TILE_SIZE);
                const pby = Math.floor(node.parent.y / TILE_SIZE);
                for (const pb of node.move.blocks) {
                    const k = tileKey(pbx + pb.dx, pby + pb.dy);
                    node.pathOcc.set(k, (node.pathOcc.get(k) || []).concat([{ low: node.parent.z + pb.low, high: node.parent.z + pb.high }]));
                }
            }
            for (const m of moves) {
                const mv = m[node.rot];
                const nz = node.z + mv.dz;
                if (nz < 0 || head > mv.limit || (mv.brakes && head <= brakeHead + 8)) continue;
                if (mv.derail.some(c => node.e - (node.z + c.zLow) > c.limit)) continue;
                const bx = Math.floor(node.x / TILE_SIZE);
                const by = Math.floor(node.y / TILE_SIZE);
                let ok = true;
                for (const blk of mv.blocks) {
                    const tx = bx + blk.dx;
                    const ty = by + blk.dy;
                    if (tx < b.minX || tx > b.maxX || ty < b.minY || ty > b.maxY || node.z + blk.z < 0
                        || spanOccupied(draft.occ, tx, ty, node.z + blk.low, node.z + blk.high)
                        || spanOccupied(node.pathOcc, tx, ty, node.z + blk.low, node.z + blk.high)) {
                        ok = false;
                        break;
                    }
                }
                if (!ok) continue;
                let e = node.e - coasterLoss(head, mv.cost, draft.massFactor);
                if (mv.brakes) e = Math.min(e, node.z + brakeHead);
                const next = { x: node.x + mv.dx, y: node.y + mv.dy, z: nz, rot: mv.rot, g: node.g + mv.cost + mv.penalty, e: e,
                    parent: node, move: mv };
                next.f = next.g + 1.5 * h(next);
                pushHeap(next);
            }
        }
        return null;
    }

    const COASTER_STYLES = {
        gentle: { lift: 5, features: [4, 6], size: [16, 10] },
        moderate: { lift: 8, features: [6, 9], size: [22, 14] },
        intense: { lift: 12, features: [7, 11], size: [28, 16] },
    };

    /** What a ride type's rating requirements ask of a layout, in generator units. */
    function coasterTargets(rideType) {
        const req = RIDE_REQUIREMENTS[rideType] || {};
        return {
            dropZ: (req.requirementDropHeight || 0) * 8,
            drops: req.requirementNumDrops || 0,
            airtime: req.requirementNegativeGs !== undefined && req.requirementNegativeGs <= 50,
            inversions: req.requirementInversions || 0,
            lengthTiles: req.requirementLength ? Math.ceil(req.requirementLength / 65536 / COASTER_METRES_PER_TILE) : 0,
            // Max speed is in the game's speed unit (65536 per ~2.25 mph).
            speedZ: req.requirementMaxSpeed ? speedHead(req.requirementMaxSpeed / 65536 * GAME_SPEED_TO_MPH) : 0,
            relaxIfInversions: !!req.relaxIfInversions,
        };
    }

    /** Which requirements a finished draft should meet (the game has the final word when it tests the ride). */
    function checkTargets(draft, targets) {
        const relaxed = targets.relaxIfInversions && draft.inversions > 0;
        const misses = [];
        if (targets.dropZ && !relaxed && draft.firstDrop < targets.dropZ) misses.push('drop height');
        if (targets.drops && !relaxed && draft.drops < targets.drops) misses.push('number of drops');
        if (targets.airtime && !relaxed && draft.airtime === 0) misses.push('airtime (negative G)');
        if (targets.inversions && draft.inversions < targets.inversions) misses.push('inversions');
        if (targets.lengthTiles && draft.length < targets.lengthTiles) misses.push('length');
        if (targets.speedZ && draft.maxHead < targets.speedZ) misses.push('max speed');
        return misses;
    }

    /** One attempt at a complete coaster; returns the draft or null (counting the reason in `why`). */
    function draftCoaster(types, info, opts, rng, why) {
        const failed = stage => {
            why[stage] = (why[stage] || 0) + 1;
            return null;
        };
        const style = COASTER_STYLES[opts.style];
        const targets = opts.targets;
        // Station along y = 0 heading -x; the track stays on the +y side, so the entrance and exit fit at y = -1.
        // The three columns behind the station (x 1-3) are kept free for the way back in.
        const bounds = { minX: -(opts.length - 4), maxX: 0, minY: 0, maxY: opts.width - 1 };
        const draft = new TrackDraft(types, info.clearance, bounds, opts.maxZ, opts.massFactor, opts.noUpstops);
        if (!draft.add(['beginStation'].concat(repeat('middleStation', opts.stationLength - 2), ['endStation']))) return failed('station');
        if (rng.chance(0.5)) draft.add(['flat']);

        // Chain lift (straight ahead, or after a turn) as high as still leaves room to turn and drop at the top.
        const minDrop = Math.max(32, targets.dropZ + 8, targets.speedZ);
        const liftSteps = Math.max(Math.ceil(minDrop / 16) + 1, opts.liftHeight);
        const steep = opts.style !== 'gentle';
        // Turning back on itself at the top gives the drop the long side of the area (an out-and-back).
        const topTurns = shuffle(rng, [['rightQuarterTurn3Tiles'], ['rightQuarterTurn5Tiles'], ['leftQuarterTurn3Tiles'],
            ['leftQuarterTurn5Tiles'], ['rightQuarterTurn1Tile'], ['leftQuarterTurn1Tile'],
            ['rightQuarterTurn3Tiles', 'rightQuarterTurn3Tiles'], ['rightQuarterTurn5Tiles', 'rightQuarterTurn5Tiles'],
            ['rightQuarterTurn3Tiles', 'flat', 'rightQuarterTurn3Tiles'], ['rightQuarterTurn1Tile', 'flat', 'rightQuarterTurn1Tile']]);
        const topOptions = rng.chance(0.4) ? [[]].concat(topTurns) : topTurns.concat([[]]);
        // After the drop the train is at its fastest: there must be room to run on or take a wide turn.
        const roomAhead = () => {
            for (const names of [['flat', 'flat', 'flat', 'flat'], ['flatToLeftBank', 'bankedLeftQuarterTurn5Tiles', 'leftBankToFlat'],
                ['flatToRightBank', 'bankedRightQuarterTurn5Tiles', 'rightBankToFlat'], ['flat', 'leftQuarterTurn5Tiles'],
                ['flat', 'rightQuarterTurn5Tiles'], ['flatToUp25', 'up25ToFlat', 'flatToDown25', 'down25ToFlat']]) {
                if (sequenceSpeedLimit(names, draft.turnScale) < draft.head()) continue;
                const mark = draft.els.length;
                if (draft.add(names)) {
                    draft.rewind(mark);
                    return true;
                }
            }
            return false;
        };
        const firstDrop = () => {
            for (const turn of topOptions) {
                const mark = draft.els.length;
                if (turn.length > 0 && !draft.add(turn)) continue;
                const top = draft.z;
                for (let depth = top; depth >= Math.max(minDrop, top / 2); depth -= 16) {
                    const beforeDrop = draft.els.length;
                    if (draft.add(dropPieces(draft, depth, steep)) || draft.add(dropPieces(draft, depth, false))) {
                        if (roomAhead()) {
                            draft.firstDrop = depth;
                            return true;
                        }
                        draft.rewind(beforeDrop);
                    }
                }
                draft.rewind(mark);
            }
            return false;
        };
        let dropped = false;
        for (const turn of rng.chance(0.35) ? [true, false] : [false, true]) {
            const beforeTurn = draft.els.length;
            if (turn && !draft.add(rng.pick([['rightQuarterTurn3Tiles'], ['rightQuarterTurn5Tiles']]))
                && !draft.add(['rightQuarterTurn5Tiles']) && !draft.add(['rightQuarterTurn3Tiles'])
                && !draft.add(['rightQuarterTurn1Tile'])) continue;
            for (let k = liftSteps - 1; k >= Math.ceil(minDrop / 16) - 1 && !dropped; k--) {
                const beforeLift = draft.els.length;
                if (!draft.add(['flatToUp25'].concat(repeat('up25', k), ['up25ToFlat']), true)) continue;
                draft.liftHeight = draft.z;
                if (rng.chance(0.5)) draft.add(['flat'], true);
                dropped = firstDrop();
                if (!dropped) draft.rewind(beforeLift);
            }
            if (dropped) break;
            draft.rewind(beforeTurn);
        }
        if (!dropped) {
            if (opts.debug) why.refusals = draft.refusals;
            return failed('lift and first drop');
        }

        // Features while there is room, steered toward whatever the ride type's ratings still need. Every option
        // that fits is tried; the pick favours the ride's style, unmet requirements and open track ahead (so the
        // layout spreads over the area instead of running into its edge), with some randomness for variety.
        const catalogue = coasterFeatureCatalogue(draft, opts.style).filter(f => f.weight > 0 && (opts.inversions || !f.inversion));
        const wanted = rng.int(style.features[0], style.features[1]);
        let placed = 0;
        const featureMarks = [];
        const needs = () => checkTargets(draft, targets);
        const runway = () => {
            let n = 0;
            const tx = Math.floor(draft.x / TILE_SIZE);
            const ty = Math.floor(draft.y / TILE_SIZE);
            for (let k = 0; k < 10; k++) {
                const x = tx + DIR_DX[draft.rot] * k;
                const y = ty + DIR_DY[draft.rot] * k;
                if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY
                    || spanOccupied(draft.occ, x, y, draft.z - 16, draft.z + 48)) break;
                n++;
            }
            return n;
        };
        for (let step = 0; step < wanted + 8; step++) {
            const missing = needs();
            const longEnough = !targets.lengthTiles || draft.length >= targets.lengthTiles * 0.8;
            if (placed >= wanted && missing.length === 0 && longEnough) break;
            const head = draft.head();
            let pick = null;
            for (const f of catalogue) {
                let w = f.weight;
                if (f.descends) w *= draft.z >= 48 ? 3 : (draft.z < 16 ? 0 : 1);
                if (f.descends && missing.includes('number of drops')) w *= 2;
                if (f.airtime && missing.includes('airtime (negative G)') && head >= 40) w *= 4;
                if (f.inversion && missing.includes('inversions')) w *= 5;
                if (f.inversion && opts.style === 'intense' && draft.inversions < 2) w *= 3;
                // Plenty of inversions get too intense for most guests.
                if (f.inversion && draft.inversions >= (opts.style === 'intense' ? 4 : 2)) w = 0;
                if (w <= 0) continue;
                for (const names of f.options(rng)) {
                    if (sequenceSpeedLimit(names, draft.turnScale) < head) continue;
                    const mark = draft.els.length;
                    if (!draft.add(names)) continue;
                    const room = runway();
                    draft.rewind(mark);
                    const score = 2 * Math.log(w) + Math.min(room, 6) + 4 * rng.next();
                    if (!pick || score > pick.score) pick = { names: names, score: score };
                }
            }
            if (!pick) break;
            featureMarks.push(draft.els.length);
            draft.add(pick.names);
            placed++;
        }

        // Back to the station (through a brake run if the train is still fast). If there is no way home from
        // where the features ended, give up the last feature and try again from there.
        if (opts.debug) why.placed = (why.placed || []).concat([placed]);
        bounds.maxX = 3;
        for (;;) {
            if (opts.budget.timedOut) return failed('out of time');
            if (opts.budget.used >= opts.budget.max) return failed('search budget used up');
            const mark = draft.els.length;
            let closing = closeCircuit(draft, 8000, opts.budget);
            if (!closing && draft.head() > speedHead(COASTER_BRAKE_SPEED * GAME_SPEED_TO_MPH) + 8 && draft.has(['brakes'])
                && draft.add(['brakes', 'brakes'])) {
                closing = closeCircuit(draft, 8000, opts.budget);
            }
            if (closing && closing.every(names => draft.add(names))
                && draft.x === 0 && draft.y === 0 && draft.z === 0 && draft.rot === 0) {
                draft.features = placed;
                return draft;
            }
            draft.rewind(mark);
            if (featureMarks.length === 0) {
                if (opts.debug && !why.closingFrom) {
                    why.closingFrom = { x: draft.x / TILE_SIZE, y: draft.y / TILE_SIZE, z: draft.z, rot: draft.rot, head: draft.head(),
                        bounds: bounds, pieces: draft.els.map(e => TRACK_TYPE_NAMES[e.type]) };
                }
                return failed('closing the circuit');
            }
            draft.rewind(featureMarks.pop());
            placed--;
        }
    }

    /**
     * The empty train's mass, composed like Ride::updateMaxVehicles: as many cars as fit the station, each car
     * chosen by its position (RideEntryGetVehicleAtPosition). Some cars weigh nothing (a wild mouse's three-car
     * train is one 440 mass car), so the cars must be added up rather than estimated.
     */
    function coasterTrainMass(option, stationTiles) {
        const info = rideTypeInfo(option.rideType);
        const maxMass = info && info.maxMass ? info.maxMass << 8 : Infinity;
        try {
            const obj = objectManager.getObject('ride', option.object);
            const vehicles = obj.vehicles || [];
            const at = (numCars, i) => {
                if (i === 0 && obj.frontVehicle !== 255) return obj.frontVehicle;
                if (i === 1 && obj.secondVehicle !== 255) return obj.secondVehicle;
                if (i === 2 && obj.thirdVehicle !== 255) return obj.thirdVehicle;
                if (i === numCars - 1 && obj.rearVehicle !== 255) return obj.rearVehicle;
                return obj.defaultVehicle;
            };
            const stationLength = stationTiles * 0x44180;
            for (let numCars = Math.max(1, obj.maxCarsInTrain || 1); numCars > 0; numCars--) {
                let length = 0;
                let mass = 0;
                for (let i = 0; i < numCars; i++) {
                    const car = vehicles[at(numCars, i)] || {};
                    length += car.spacing || 0;
                    mass += car.carMass || 0;
                }
                if ((length <= stationLength && mass <= maxMass) || numCars === 1) return mass;
            }
        } catch (e) {
            return 0;
        }
        return 0;
    }

    /**
     * How much more drag the ride's (empty, as in testing) train suffers than a ~4000 mass coaster train: drag
     * deceleration is inversely proportional to train mass, so light single cars such as wild mice (~440) slow
     * down much faster (a 440 mass car at 30 mph feels drag close to gravity on a 25 degree slope).
     */
    function coasterMassFactor(option, stationTiles) {
        const mass = coasterTrainMass(option, stationTiles);
        return mass > 0 ? Math.max(1, Math.min(10, 4000 / mass)) : 3;
    }

    /** 2 if the ride's cars are bobsleighs without upstop wheels, 1 for other cars without them, else 0. */
    function coasterNoUpstops(option) {
        let result = 0;
        try {
            const bit = (flags, n) => Math.floor(flags / Math.pow(2, n)) % 2 === 1;
            for (const car of objectManager.getObject('ride', option.object).vehicles || []) {
                if (!car.carMass) continue;
                if (bit(car.flags, CAR_FLAG_NO_UPSTOPS_BOBSLEIGH)) result = 2;
                else if (bit(car.flags, CAR_FLAG_NO_UPSTOPS) && result === 0) result = 1;
            }
        } catch (e) {
            result = 0;
        }
        return result;
    }

    /** Roller coasters this park can build with a chain lift, best suited to the style first. */
    function coasterCandidates(params, style) {
        let options;
        if (params.ride !== undefined || params.object !== undefined || isNumber(params.rideType)) {
            options = [resolveRideOption(params, ['tracked'])];
        } else {
            options = buildableRideOptions().filter(o => o.kind === 'tracked' && o.category === 'rollercoaster');
        }
        const scored = [];
        for (const option of options) {
            const allowed = allowedPieceTypes(option.rideType);
            const types = new Map();
            for (const t of allowed) types.set(TRACK_TYPE_NAMES[t], t);
            const lift = rideHasChainLift(option.rideType)
                && ['flatToUp25', 'up25', 'up25ToFlat'].every(n => types.has(n) && trackSegment(types.get(n)).allowsChainLift);
            if (!lift || !['beginStation', 'middleStation', 'endStation', 'flatToDown25', 'down25ToFlat'].every(n => types.has(n))) continue;
            // A circuit needs some way to turn round (Heartline Twisters and Impulse coasters have none).
            const turns = ['leftQuarterTurn3Tiles', 'leftQuarterTurn5Tiles', 'leftQuarterTurn1Tile', 'bankedLeftQuarterTurn5Tiles',
                'leftBankedQuarterTurn3Tiles'];
            if (!turns.some(n => types.has(n) && types.has(mirrorPieceName(n)))) continue;
            const info = rideTypeInfo(option.rideType);
            let score = 0;
            const inversions = ['leftVerticalLoop', 'leftCorkscrewUp', 'leftLargeCorkscrewUp'].filter(n => types.has(n)).length;
            score += style === 'intense' ? 2 * inversions : style === 'gentle' ? -2 * inversions : Math.min(inversions, 1);
            if (types.has('down60')) score += style === 'gentle' ? -1 : 1;
            if (types.has('bankedLeftQuarterTurn5Tiles')) score += 1;
            if (info.maxHeight < 16) score += style === 'gentle' ? 3 : -3;
            // Long minimum lengths are hard to meet in a compact layout.
            if (coasterTargets(option.rideType).lengthTiles > 60) score -= 2;
            scored.push({ option: option, types: types, info: info, score: score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    // ------------------------------------------------------------------
    // RPC methods
    // ------------------------------------------------------------------

    const methods = {};

    methods.ping = () => ({
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        apiVersion: context.apiVersion,
        mode: context.mode,
        paused: context.paused,
        network: network.mode,
    });

    methods.get_park_info = () => {
        if (context.mode !== 'normal' && context.mode !== 'scenario_editor') {
            return { mode: context.mode, loaded: false };
        }
        let objective = null;
        let scenarioName = null;
        try {
            scenarioName = scenario.name;
            const o = scenario.objective;
            objective = {
                type: o.type, guests: o.guests, year: o.year, parkValue: o.parkValue,
                excitement: o.excitement, length: o.length,
            };
        } catch (e) {
            objective = null;
        }
        let rideCount = 0;
        try {
            rideCount = map.numRides;
        } catch (e) {
            rideCount = 0;
        }
        return {
            mode: context.mode,
            loaded: true,
            name: park.name,
            cash: park.cash,
            cashFormatted: formatMoney(park.cash),
            noMoney: noMoney(),
            bankLoan: park.bankLoan,
            maxBankLoan: park.maxBankLoan,
            rating: park.rating,
            guests: park.guests,
            parkValue: park.value,
            companyValue: park.companyValue,
            entranceFee: park.entranceFee,
            date: { day: date.day, month: MONTH_NAMES[date.month] || date.month, year: date.year },
            mapSize: map.size,
            rideCount: rideCount,
            paused: context.paused,
            cheats: { buildInPauseMode: cheats.buildInPauseMode, sandboxMode: cheats.sandboxMode },
            network: network.mode,
            scenario: { name: scenarioName, objective: objective },
        };
    };

    methods.list_rides = async params => {
        const tc = new TileCache();
        const entrances = await getParkEntrances();
        const network = computeParkNetwork(tc, entrances);
        const filter = params.classification;
        const name = typeof params.name === 'string' ? params.name.toLowerCase() : null;
        let list = map.rides
            .filter(r => !filter || r.classification === filter)
            .filter(r => {
                if (!name) return true;
                let objectName = '';
                try {
                    objectName = r.object ? r.object.name : '';
                } catch (e) {
                    objectName = '';
                }
                return r.name.toLowerCase().includes(name) || objectName.toLowerCase().includes(name);
            })
            .map(r => summariseRide(tc, r, entrances.length > 0 ? network : null, false));
        if (params.needsPaths) list = list.filter(rideNeedsPaths);
        return list;
    };

    methods.get_ride = async params => {
        const ride = getRideOrFail(params.rideId);
        const tc = new TileCache();
        const entrances = await getParkEntrances();
        const network = computeParkNetwork(tc, entrances);
        const summary = summariseRide(tc, ride, entrances.length > 0 ? network : null, true);
        Object.assign(summary, {
            mode: ride.mode,
            age: ride.age,
            value: money(ride.value),
            runningCost: money(ride.runningCost),
            totalProfit: money(ride.totalProfit),
            satisfaction: ride.satisfaction,
            reliability: ride.reliability,
            downtime: ride.downtime,
            maxSpeed: ride.maxSpeed,
            rideLength: ride.rideLength,
            vehicles: ride.vehicles ? ride.vehicles.length : 0,
        });
        return summary;
    };

    methods.find_park_entrances = async () => {
        const list = await getParkEntrances();
        return list.map(e => ({
            x: e.x, y: e.y, z: e.z, direction: e.dir,
            pathTiles: [e.dir, e.dir ^ 2].map(d => ({ x: e.x + DIR_DX[d], y: e.y + DIR_DY[d] })),
        }));
    };

    methods.get_map_region = params => {
        const size = map.size;
        let x1 = requireInt(params, 'x1');
        let y1 = requireInt(params, 'y1');
        let x2 = requireInt(params, 'x2');
        let y2 = requireInt(params, 'y2');
        if (x1 > x2) [x1, x2] = [x2, x1];
        if (y1 > y2) [y1, y2] = [y2, y1];
        x1 = Math.max(0, x1);
        y1 = Math.max(0, y1);
        x2 = Math.min(size.x - 1, x2);
        y2 = Math.min(size.y - 1, y2);
        const w = x2 - x1 + 1;
        const h = y2 - y1 + 1;
        if (w <= 0 || h <= 0) fail('Region is outside the map (map size ' + size.x + 'x' + size.y + ').');
        if (w * h > MAX_REGION_TILES) fail('Region too large: ' + w + 'x' + h + ' tiles (max ' + MAX_REGION_TILES + ' tiles).');

        const rideSymbols = new Map();
        const symbolPool = 'abcdefghijklmnopqrstuvwyz0123456789';
        const rideSymbol = id => {
            if (!rideSymbols.has(id)) {
                rideSymbols.set(id, rideSymbols.size < symbolPool.length ? symbolPool[rideSymbols.size] : '@');
            }
            return rideSymbols.get(id);
        };

        const rows = [];
        const heights = [];
        for (let y = y1; y <= y2; y++) {
            let row = '';
            const hrow = [];
            for (let x = x1; x <= x2; x++) {
                const info = readTile(x, y);
                row += tileSymbol(info, rideSymbol);
                hrow.push(info.surface ? info.surface.z : null);
            }
            rows.push(row);
            heights.push(hrow);
        }

        const rides = {};
        rideSymbols.forEach((sym, id) => {
            rides[sym] = { id: id, name: getRideName(id) };
        });

        const result = {
            x1: x1, y1: y1, x2: x2, y2: y2,
            rows: rows,
            rides: rides,
            legend: {
                '.': 'owned land, flat',
                '/': 'owned land, gentle slope (path can follow it)',
                '^': 'owned land, steep/irregular slope (needs elevated path or landscaping)',
                ';': 'construction rights only (can build above/below ground, not on it)',
                ':': 'land not owned by the park (cannot build)',
                '~': 'water',
                '#': 'footpath',
                '=': 'queue line',
                'E': 'ride entrance',
                'X': 'ride exit',
                'P': 'park entrance',
                '*': 'small scenery (trees, etc.)',
                '%': 'large scenery / building',
                'letters/digits': 'ride or stall structure (see rides)',
            },
            orientation: 'Rows are y (increasing downward), columns are x (increasing rightward).',
        };
        if (params.includeHeights) {
            result.surfaceHeights = heights;
        }
        return result;
    };

    function tileSymbol(info, rideSymbol) {
        for (const e of info.entrances) {
            if (e.ghost) continue;
            if (e.type === ENTRANCE_PARK) return 'P';
            if (e.type === ENTRANCE_RIDE_EXIT) return 'X';
            return 'E';
        }
        const track = info.tracks.find(t => !t.ghost);
        if (track) return rideSymbol(track.ride);
        const paths = info.paths.filter(p => !p.ghost);
        if (paths.length > 0) return paths.some(p => !p.queue) ? '#' : '=';
        if (info.largeScenery > 0) return '%';
        if (info.smallScenery > 0) return '*';
        const s = info.surface;
        if (!s) return '?';
        if (s.water > s.z) return '~';
        if (!s.owned) return s.rights ? ';' : ':';
        if (!info.terrain) return '^';
        return info.terrain.s >= 0 || info.terrain.z !== s.z ? '/' : '.';
    }

    methods.get_tile = params => {
        const x = requireInt(params, 'x');
        const y = requireInt(params, 'y');
        const size = map.size;
        if (x < 0 || y < 0 || x >= size.x || y >= size.y) fail('Tile is outside the map.');
        const elements = map.getTile(x, y).elements;
        const out = [];
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            const base = { index: i, type: el.type, baseZ: el.baseZ, clearanceZ: el.clearanceZ };
            if (el.isGhost) base.ghost = true;
            switch (el.type) {
                case 'surface': {
                    const surface = { z: el.baseZ, slope: el.slope };
                    const tp = terrainPlacement(surface);
                    Object.assign(base, {
                        slope: el.slope,
                        waterZ: el.waterHeight,
                        owned: el.hasOwnership,
                        constructionRights: el.hasConstructionRights,
                        footpathOnTerrain: tp ? { z: tp.z, slope: tp.s < 0 ? 'flat' : tp.s } : null,
                    });
                    break;
                }
                case 'footpath': {
                    const edges = [];
                    for (let d = 0; d < 4; d++) if (el.edges & (1 << d)) edges.push(d);
                    Object.assign(base, {
                        slope: el.slopeDirection === null ? 'flat' : el.slopeDirection,
                        isQueue: el.isQueue,
                        connectedDirections: edges,
                        surface: el.object !== null
                            ? getObjectName('footpath', el.object)
                            : getObjectName('footpath_surface', el.surfaceObject),
                        railings: getObjectName('footpath_railings', el.railingsObject),
                        addition: getObjectName('footpath_addition', el.addition),
                    });
                    if (el.isQueue && el.ride !== null) base.queueForRide = el.ride;
                    break;
                }
                case 'track':
                    Object.assign(base, {
                        ride: el.ride,
                        rideName: getRideName(el.ride),
                        trackType: el.trackType,
                        sequence: el.sequence,
                        direction: el.direction,
                        // Only station pieces have a readable station index (others log a warning).
                        station: STATION_TRACK_TYPES.includes(el.trackType) ? el.station : undefined,
                    });
                    break;
                case 'entrance': {
                    const away = el.direction ^ 2;
                    Object.assign(base, {
                        kind: ENTRANCE_TYPE_NAMES[el.object] || el.object,
                        direction: el.direction,
                        sequence: el.sequence,
                    });
                    if (el.object !== ENTRANCE_PARK) {
                        Object.assign(base, {
                            ride: el.ride,
                            rideName: getRideName(el.ride),
                            station: el.station,
                            pathConnectsFrom: { x: x + DIR_DX[away], y: y + DIR_DY[away] },
                        });
                    }
                    break;
                }
                case 'small_scenery':
                    Object.assign(base, { object: getObjectName('small_scenery', el.object), direction: el.direction });
                    break;
                case 'large_scenery':
                    Object.assign(base, { object: getObjectName('large_scenery', el.object), direction: el.direction });
                    break;
                case 'wall':
                    Object.assign(base, { object: getObjectName('wall', el.object), edge: el.direction });
                    break;
                case 'banner':
                    Object.assign(base, { edge: el.direction });
                    break;
            }
            out.push(base);
        }
        return { x: x, y: y, elements: out };
    };

    methods.list_footpath_objects = () => {
        const surfaces = loadedObjects('footpath_surface').map(o => ({
            index: o.index,
            identifier: o.identifier,
            name: o.name,
            isQueue: !!(o.flags & SURFACE_FLAG_QUEUE),
            editorOnly: !!(o.flags & SURFACE_FLAG_EDITOR_ONLY),
        }));
        const railings = loadedObjects('footpath_railings').map(o => ({
            index: o.index, identifier: o.identifier, name: o.name,
        }));
        const legacy = loadedObjects('footpath').map(o => ({ index: o.index, identifier: o.identifier, name: o.name }));
        return { surfaces: surfaces, railings: railings, legacyFootpaths: legacy };
    };

    methods.connect_ride_exit = async params => {
        const ride = getRideOrFail(params.rideId);
        const tc = new TileCache();
        const { portal, stationIndex } = findStationPortal(tc, ride, params, 'exit');
        const goal = await networkGoal(tc, null);

        let sources = [portalSource(portal)];
        if (portal.unjoinedPath && portal.unjoinedPath.queue) {
            fail('The tile in front of the exit (' + portal.frontTile.x + ',' + portal.frontTile.y + ') holds a queue line that '
                + 'is not joined to the exit. Remove it (remove_footpath) or turn it into a normal path (place_footpath) first.');
        }
        if (portal.connectedPath) {
            const p0 = portal.connectedPath;
            if (goal.allPaths) {
                return {
                    ride: ride.name, station: stationIndex, alreadyConnected: true,
                    message: 'The exit already has a path. This park has no park entrance, so whether guests can reach '
                        + 'it cannot be checked; use build_path_route to join paths together if needed.',
                };
            }
            if (reachesNetwork(tc, p0.x, p0.y, p0.piece, goal.set)) {
                return {
                    ride: ride.name, station: stationIndex, alreadyConnected: true,
                    message: 'The exit already connects to the park\'s path network'
                        + (p0.isQueue ? ' (through a queue tile directly in front of it).' : '.'),
                };
            }
            // Something is attached but it does not reach the park yet: carry on from there.
            const p = portal.connectedPath.piece;
            sources = [{ x: portal.frontTile.x, y: portal.frontTile.y, z: p.z, s: p.s, existing: true, piece: p, dir: portal.pathDirection }];
        }

        const result = await planAndBuild(tc, {
            sources: sources,
            goal: goal,
            waypoints: sanitiseWaypoints(params.waypoints),
            queue: false,
            portal: portal,
            near: portal.frontTile,
            endpointZ: portal.z,
        }, params);
        result.ride = ride.name;
        result.station = stationIndex;
        result.exit = { x: portal.x, y: portal.y, z: portal.z };
        result.goal = goal.description;
        if (!result.dryRun) {
            const after = describePortal(new TileCache(), { x: portal.x * TILE_SIZE, y: portal.y * TILE_SIZE, z: portal.z, direction: portal.direction },
                ENTRANCE_RIDE_EXIT, ride.id, stationIndex);
            result.exitConnected = after.connected;
        }
        return result;
    };

    methods.build_ride_queue = async params => {
        const ride = getRideOrFail(params.rideId);
        const tc = new TileCache();
        const { portal, stationIndex } = findStationPortal(tc, ride, params, 'entrance');
        if (portal.connectedPath || portal.unjoinedPath) {
            fail('The entrance of "' + ride.name + '" already has a path in front of it at ' + portal.frontTile.x + ','
                + portal.frontTile.y + '. Remove it first (remove_footpath) if you want to rebuild the queue.');
        }
        const goal = await networkGoal(tc, null);
        const result = await planAndBuild(tc, {
            sources: [portalSource(portal)],
            goal: goal,
            waypoints: sanitiseWaypoints(params.waypoints),
            queue: true,
            portal: portal,
            near: portal.frontTile,
            endpointZ: portal.z,
        }, params);
        result.ride = ride.name;
        result.station = stationIndex;
        result.entrance = { x: portal.x, y: portal.y, z: portal.z };
        result.goal = goal.description;
        if (!result.dryRun) {
            const tc2 = new TileCache();
            const after = describePortal(tc2, { x: portal.x * TILE_SIZE, y: portal.y * TILE_SIZE, z: portal.z, direction: portal.direction },
                ENTRANCE_RIDE_ENTRANCE, ride.id, stationIndex);
            result.entranceConnected = after.connected;
            const entrances = await getParkEntrances();
            if (entrances.length > 0) {
                result.queueReachesParkNetwork = queueReachesNetwork(tc2, after, computeParkNetwork(tc2, entrances));
            }
        }
        return result;
    };

    methods.build_path_route = async params => {
        const tc = new TileCache();
        const from = params.from;
        if (!from || !isNumber(from.x) || !isNumber(from.y)) fail('Parameter "from" must be {x, y[, z]}.');
        const fx = Math.floor(from.x);
        const fy = Math.floor(from.y);
        const fz = isNumber(from.z) ? Math.floor(from.z) : null;
        const sources = tileSources(tc, fx, fy, fz);

        let goal;
        const to = params.to;
        if (to === undefined || to === null || to === 'network') {
            const fragment = sources[0].existing ? pathFragmentFrom(tc, fx, fy, sources[0].piece) : null;
            goal = await networkGoal(tc, fragment);
            if (sources[0].existing && !goal.allPaths && goal.set.has(pieceKey(fx, fy, sources[0].z))) {
                return { alreadyConnected: true, message: 'The start tile is already part of the park\'s path network.' };
            }
        } else {
            if (!isNumber(to.x) || !isNumber(to.y)) fail('Parameter "to" must be {x, y} or "network".');
            goal = { kind: 'tile', x: Math.floor(to.x), y: Math.floor(to.y), description: 'tile ' + to.x + ',' + to.y };
            if (goal.x === fx && goal.y === fy) fail('"from" and "to" are the same tile.');
        }

        const queue = !!params.queue;
        const maxZ = Math.max(...sources.map(s => s.z));
        const result = await planAndBuild(tc, {
            sources: sources,
            goal: goal,
            waypoints: sanitiseWaypoints(params.waypoints),
            queue: queue,
            portal: null,
            near: { x: fx, y: fy },
            endpointZ: maxZ,
        }, params);
        result.goal = goal.description;
        return result;
    };

    methods.place_footpath = async params => {
        const tiles = params.tiles;
        if (!Array.isArray(tiles) || tiles.length === 0) fail('Parameter "tiles" must be a non-empty array of {x, y[, z, slope]}.');
        if (tiles.length > 500) fail('At most 500 tiles per call.');
        ensureCanBuild(params);
        const tc = new TileCache();
        const queue = !!params.queue;
        const style = resolvePathStyle(tc, { x: Math.floor(tiles[0].x), y: Math.floor(tiles[0].y) }, queue, params);
        const flags = buildFlags(params);

        const pieces = [];
        const problems = [];
        let total = 0;
        let prev = null;
        for (const t of tiles) {
            if (!t || !isNumber(t.x) || !isNumber(t.y)) fail('Each tile must have numeric x and y.');
            const x = Math.floor(t.x);
            const y = Math.floor(t.y);
            const info = tc.get(x, y);
            if (!info) {
                problems.push({ x: x, y: y, error: 'outside the buildable map area' });
                continue;
            }
            let z;
            let s;
            if (isNumber(t.z)) {
                z = Math.floor(t.z);
                s = isNumber(t.slope) ? Math.floor(t.slope) & 3 : -1;
            } else if (info.terrain) {
                z = info.terrain.z;
                s = info.terrain.s;
            } else {
                problems.push({ x: x, y: y, error: 'terrain too steep for a footpath; give z (and slope) explicitly' });
                continue;
            }
            let dir = null;
            if (prev && Math.abs(prev.x - x) + Math.abs(prev.y - y) === 1) {
                dir = DIR_DX.findIndex((dx, d) => prev.x + dx === x && prev.y + DIR_DY[d] === y);
            }
            const piece = { x: x, y: y, z: z, s: s, dir: dir };
            const res = queryActionSync('footpathplace', footpathArgs(piece, style, flags));
            if (res.error !== 0) {
                problems.push({ x: x, y: y, z: z, error: describeResult(res) });
            } else {
                total += res.cost || 0;
                pieces.push(piece);
            }
            prev = { x: x, y: y };
        }

        const summary = {
            dryRun: !!params.dryRun,
            kind: queue ? 'queue' : 'footpath',
            style: describeStyle(style),
            valid: pieces.map(p => ({ x: p.x, y: p.y, z: p.z, slope: p.s < 0 ? 'flat' : p.s })),
            rejected: problems,
            estimatedCost: total,
            estimatedCostFormatted: formatMoney(total),
        };
        if (params.dryRun || pieces.length === 0) return summary;
        if (problems.length > 0 && !params.skipInvalid) {
            summary.dryRun = true;
            summary.message = 'Nothing was built because some tiles are invalid. Fix them, or pass skipInvalid=true to build the valid ones.';
            return summary;
        }
        const results = await Promise.all(pieces.map(p => executeAction('footpathplace', footpathArgs(p, style, flags))));
        let spent = 0;
        const errors = [];
        results.forEach((res, i) => {
            if (res.error === 0) spent += res.cost || 0;
            else errors.push({ x: pieces[i].x, y: pieces[i].y, error: describeResult(res) });
        });
        summary.built = pieces.length - errors.length;
        summary.cost = spent;
        summary.costFormatted = formatMoney(spent);
        if (errors.length > 0) summary.errors = errors;
        log('Placed ' + summary.built + ' ' + summary.kind + ' tile(s) for ' + summary.costFormatted);
        return summary;
    };

    methods.remove_footpath = async params => {
        const tiles = params.tiles;
        if (!Array.isArray(tiles) || tiles.length === 0) fail('Parameter "tiles" must be a non-empty array of {x, y[, z]}.');
        if (tiles.length > 500) fail('At most 500 tiles per call.');
        ensureCanBuild(params);
        const flags = buildFlags(params);
        const tc = new TileCache();
        const targets = [];
        const problems = [];
        for (const t of tiles) {
            const x = Math.floor(t.x);
            const y = Math.floor(t.y);
            const info = tc.get(x, y);
            const paths = info ? info.paths.filter(p => !p.ghost && (!isNumber(t.z) || p.z === t.z)) : [];
            if (paths.length === 0) {
                problems.push({ x: x, y: y, error: 'no footpath here' + (isNumber(t.z) ? ' at z ' + t.z : '') });
                continue;
            }
            for (const p of paths) targets.push({ x: x, y: y, z: p.z });
        }
        if (params.dryRun) {
            const ok = [];
            let cost = 0;
            for (const t of targets) {
                const res = queryActionSync('footpathremove', { x: t.x * TILE_SIZE, y: t.y * TILE_SIZE, z: t.z, flags: flags });
                if (res.error === 0) {
                    ok.push(t);
                    cost += res.cost || 0;
                } else {
                    problems.push({ x: t.x, y: t.y, z: t.z, error: describeResult(res) });
                }
            }
            return { dryRun: true, toRemove: ok, estimatedCost: cost, estimatedCostFormatted: formatMoney(cost), rejected: problems };
        }
        const results = await Promise.all(targets.map(t => executeAction('footpathremove',
            { x: t.x * TILE_SIZE, y: t.y * TILE_SIZE, z: t.z, flags: flags })));
        let cost = 0;
        results.forEach((res, i) => {
            if (res.error === 0) cost += res.cost || 0;
            else problems.push({ x: targets[i].x, y: targets[i].y, z: targets[i].z, error: describeResult(res) });
        });
        const removed = results.filter(r => r.error === 0).length;
        log('Removed ' + removed + ' footpath tile(s)');
        return { removed: removed, cost: cost, costFormatted: formatMoney(cost), rejected: problems };
    };

    methods.execute_action = async params => {
        const action = params.action;
        if (typeof action !== 'string' || action.length === 0) fail('Parameter "action" must be a game action name.');
        const args = params.args && typeof params.args === 'object' ? Object.assign({}, params.args) : {};
        if (!isNumber(args.flags)) args.flags = 0;
        if (params.query) {
            const res = queryActionSync(action, args);
            if (res.error === -2) {
                fail('The game rejected the action: ' + res.errorMessage + ' Every argument of "' + action + '" must be given '
                    + '(see the action\'s Args interface in openrct2.d.ts); world x/y are tile * 32.', { argsGiven: Object.keys(args) });
            }
            return { query: true, result: res };
        }
        const res = await executeAction(action, args);
        if (res.error === -2) {
            fail('The game rejected the action: ' + res.errorMessage + ' Every argument of "' + action + '" must be given '
                + '(see the action\'s Args interface in openrct2.d.ts); world x/y are tile * 32.', { argsGiven: Object.keys(args) });
        }
        log('Executed ' + action + ': ' + describeResult(res));
        return { query: false, result: res };
    };

    methods.set_paused = async params => {
        const wanted = !!params.paused;
        if (context.paused === wanted) return { paused: wanted, changed: false };
        const res = await executeAction('pausetoggle', { flags: 0 });
        return { paused: context.paused, changed: res.error === 0, result: describeResult(res) };
    };

    methods.scroll_view = params => {
        if (typeof ui === 'undefined') fail('No user interface (headless game).');
        const x = requireInt(params, 'x');
        const y = requireInt(params, 'y');
        ui.mainViewport.scrollTo({ x: x * TILE_SIZE + 16, y: y * TILE_SIZE + 16 });
        return { ok: true };
    };

    methods.eval = params => {
        if (!getSetting('allowEval', false)) {
            fail('run_plugin_script is disabled. The player can enable it with the checkbox in the in-game '
                + '"AI Control Plane" window, or by adding {"AIControlPlane": {"allowEval": true}} to plugin.store.json '
                + 'in the OpenRCT2 user folder while the game is closed.');
        }
        if (typeof params.code !== 'string') fail('Parameter "code" must be a string.');
        const fn = new Function('"use strict"; return (async () => { ' + params.code + ' })();');
        return fn();
    };

    methods.list_buildable_rides = params => {
        let options = buildableRideOptions();
        if (params.category) options = options.filter(o => o.category === params.category);
        if (params.kind) options = options.filter(o => o.kind === params.kind);
        if (typeof params.name === 'string') {
            const needle = params.name.toLowerCase();
            options = options.filter(o => o.name.toLowerCase().includes(needle) || o.rideTypeName.includes(needle));
        }
        return options.map(o => {
            const out = Object.assign({}, o);
            if (!params.descriptions) delete out.description;
            return out;
        });
    };

    methods.find_build_sites = async params => {
        let width = optInt(params, 'width', null);
        let length = optInt(params, 'length', null);
        if (params.ride !== undefined || params.object !== undefined || isNumber(params.rideType)) {
            const option = resolveRideOption(params, ['flat', 'stall', 'tower']);
            const fp = pieceFootprint(rideTypeInfo(option.rideType).startPiece);
            width = fp.width;
            length = fp.length;
        }
        if (!width || !length) fail('Give a ride ("ride", "object" or "rideType") or a footprint "width" and "length" in tiles.');
        const tc = new TileCache();
        const sites = await findSites(tc, {
            width: width, length: length, margin: optInt(params, 'margin', 1),
            near: params.near || 'water', radius: optInt(params, 'radius', 12), maxResults: optInt(params, 'maxResults', 5),
        });
        if (width !== length) {
            const turned = await findSites(tc, {
                width: length, length: width, margin: optInt(params, 'margin', 1),
                near: params.near || 'water', radius: optInt(params, 'radius', 12), maxResults: optInt(params, 'maxResults', 5),
            });
            sites.push(...turned);
            sites.sort((a, b) => a.distanceToTarget - b.distanceToTarget || (a.distanceToPath || 99) - (b.distanceToPath || 99));
        }
        return { footprint: { width: width, length: length }, sites: sites.slice(0, optInt(params, 'maxResults', 5)) };
    };

    /** Candidate placements (origin + direction + z) for a single-piece ride. */
    async function singlePiecePlacements(tc, params, fp) {
        const directions = isNumber(params.direction) ? [params.direction & 3] : [0, 1, 2, 3];
        const out = [];
        if (isNumber(params.x) && isNumber(params.y)) {
            for (const d of directions) {
                const origin = originForCorner(fp, Math.floor(params.x), Math.floor(params.y), d);
                const tiles = placedFootprint(fp, origin.x, origin.y, d);
                let z = isNumber(params.z) ? Math.floor(params.z) : null;
                if (z === null) {
                    for (const t of tiles) {
                        const info = tc.get(t.x, t.y);
                        if (!info || !info.surface) fail('The footprint at ' + params.x + ',' + params.y + ' runs off the map.');
                        const top = info.surface.z + ((info.surface.slope & 0x0F) ? LAND_STEP : 0) + ((info.surface.slope & 0x10) ? LAND_STEP : 0);
                        z = Math.max(z === null ? 0 : z, top);
                    }
                }
                out.push({ origin: origin, direction: d, z: z });
            }
            return out;
        }
        const near = params.near || 'water';
        const radius = optInt(params, 'radius', 12);
        const shapes = fp.width === fp.length ? [[fp.width, fp.length, [0, 1, 2, 3]]]
            : [[fp.width, fp.length, [0, 2]], [fp.length, fp.width, [1, 3]]];
        const all = [];
        for (const [w, l, dirs] of shapes) {
            const sites = await findSites(tc, { width: w, length: l, margin: 1, near: near, radius: radius, maxResults: 6 });
            for (const site of sites) {
                for (const d of dirs) {
                    if (!directions.includes(d)) continue;
                    all.push({ origin: originForCorner(fp, site.x, site.y, d), direction: d, z: site.z, site: site });
                }
            }
        }
        all.sort((a, b) => a.site.distanceToTarget - b.site.distanceToTarget
            || (a.site.distanceToPath === null ? 99 : a.site.distanceToPath) - (b.site.distanceToPath === null ? 99 : b.site.distanceToPath));
        if (all.length === 0) {
            fail('No free, level, owned area for a ' + fp.width + 'x' + fp.length + ' ride was found within ' + radius
                + ' tiles of ' + (near === 'water' ? 'water' : near.x + ',' + near.y) + '. Try a larger radius, another spot, '
                + 'or clear/buy land.');
        }
        return all;
    }

    methods.build_flat_ride = async params => {
        ensureCanBuild(params);
        checkStatusParam(params);
        const option = resolveRideOption(params, ['flat', 'stall']);
        const info = rideTypeInfo(option.rideType);
        const fp = pieceFootprint(info.startPiece);
        if (!fp) fail('Unknown footprint for ' + option.name + '.');
        const isStall = info.kind === 'stall';
        const flags = buildFlags(params);
        const tc = new TileCache();
        const placements = await singlePiecePlacements(tc, params, fp);

        const entrances = await getParkEntrances();
        const goal = entrances.length > 0 ? { tiles: entrances.map(e => [e.x, e.y]) } : null;
        if (goal) {
            for (const key of computeParkNetwork(tc, entrances)) {
                const [nx, ny] = key.split(',');
                goal.tiles.push([+nx, +ny]);
            }
        }
        const field = goal ? distanceField(tc, goal.tiles) : null;

        // Work out entrances/exits for each placement before touching the game.
        const plans = [];
        for (const p of placements) {
            const candidates = attachmentPoints(info.startPiece, fp, p.origin.x, p.origin.y, p.direction);
            if (isStall) {
                // The path goes on the tile right beside the open side; an existing path there is ideal.
                const spots = candidates.filter(a => stallSpotOk(tc, a.x, a.y, p.z)).map(a => {
                    const d = field ? field(a.x, a.y) : 0;
                    const hasPath = tc.get(a.x, a.y).paths.some(q => !q.ghost && !q.queue && q.z === p.z);
                    return Object.assign({ distance: hasPath ? -1 : (d < 0 ? 999 : d), hasPath: hasPath }, a);
                }).sort((a, b) => a.distance - b.distance);
                if (spots.length > 0) plans.push(Object.assign({ pathFrom: spots[0] }, p));
            } else {
                const points = rankAttachments(tc, candidates, field, p.z);
                const pair = chooseEntranceAndExit(points);
                if (pair) plans.push(Object.assign({ entrance: pair.entrance, exit: pair.exit }, p));
            }
        }
        if (plans.length === 0) fail('Found room for the ride but no usable spot for its ' + (isStall ? 'path' : 'entrance and exit') + '.');

        const describePlan = plan => {
            const tiles = placedFootprint(fp, plan.origin.x, plan.origin.y, plan.direction);
            const out = {
                ride: option.name,
                kind: info.kind,
                footprint: {
                    x1: Math.min(...tiles.map(t => t.x)), y1: Math.min(...tiles.map(t => t.y)),
                    x2: Math.max(...tiles.map(t => t.x)), y2: Math.max(...tiles.map(t => t.y)), z: plan.z,
                },
                direction: plan.direction,
            };
            if (plan.entrance) out.entrance = { x: plan.entrance.x, y: plan.entrance.y };
            if (plan.exit) out.exit = { x: plan.exit.x, y: plan.exit.y };
            if (plan.pathFrom) out.pathConnection = { x: plan.pathFrom.x, y: plan.pathFrom.y };
            if (plan.site) out.site = { distanceToTarget: plan.site.distanceToTarget, distanceToPath: plan.site.distanceToPath };
            return out;
        };
        if (params.dryRun) {
            return Object.assign({ dryRun: true, note: 'Placement checked against land, ownership and obstacles; the game '
                + 'validates the final placement when building.' }, describePlan(plans[0]),
                { alternatives: plans.slice(1, 4).map(describePlan) });
        }

        const rideId = await createRide(option, params, flags);
        let built = null;
        let spent = 0;
        const reasons = [];
        try {
            for (const plan of plans.slice(0, 12)) {
                const args = rideActionArgs(rideId, info.startPiece, option.rideType, plan.origin.x, plan.origin.y, plan.z,
                    plan.direction, { flags: flags });
                const q = queryActionSync('trackplace', args);
                if (q.error !== 0) {
                    reasons.push(describeResult(q));
                    continue;
                }
                const res = await executeAction('trackplace', args);
                if (res.error !== 0) {
                    reasons.push(describeResult(res));
                    continue;
                }
                spent += res.cost || 0;
                built = plan;
                break;
            }
            if (!built) {
                fail('The game rejected every candidate placement.', { reasons: Array.from(new Set(reasons)).slice(0, 6) });
            }

            if (!isStall) {
                for (const which of ['entrance', 'exit']) {
                    const point = built[which];
                    const res = await executeAction('rideentranceexitplace', {
                        x: point.x * TILE_SIZE, y: point.y * TILE_SIZE, direction: point.direction,
                        ride: rideId, station: 0, isExit: which === 'exit', flags: flags,
                    });
                    if (res.error !== 0) fail('Could not place the ' + which + ': ' + describeResult(res));
                    spent += res.cost || 0;
                }
            }
        } catch (e) {
            await demolishRide(rideId, flags);
            throw e;
        }

        const summary = Object.assign({ built: true, rideId: rideId }, describePlan(built));
        try {
            summary.name = map.getRide(rideId).name;
            if (typeof params.name === 'string' && params.name) {
                const r = await executeAction('ridesetname', { ride: rideId, name: params.name, flags: flags });
                if (r.error === 0) summary.name = params.name;
            }
        } catch (e) {
            // naming is cosmetic
        }
        log('Built ' + summary.name + ' at ' + summary.footprint.x1 + ',' + summary.footprint.y1);

        if (params.connectPaths !== false) {
            const pathParams = { rideId: rideId, allowWhilePaused: params.allowWhilePaused };
            summary.paths = {};
            if (isStall) {
                try {
                    const spot = built.pathFrom;
                    const r = await methods.build_path_route(Object.assign({ from: { x: spot.x, y: spot.y, z: built.z } }, pathParams));
                    summary.paths.access = r.alreadyConnected ? 'already connected' : { built: r.built, cost: r.costFormatted };
                    spent += r.cost || 0;
                    // A path that was already there joins the stall once re-placed (the game recomputes its edges).
                    const existing = new TileCache().get(spot.x, spot.y).paths.find(q => !q.ghost && !q.queue && q.z === built.z);
                    if (spot.hasPath && existing) {
                        await executeAction('footpathplace', footpathArgs({ x: spot.x, y: spot.y, z: existing.z, s: existing.s, dir: null },
                            styleOfPiece(existing), buildFlags(params)));
                    }
                } catch (e) {
                    summary.paths.access = 'failed: ' + e.message;
                }
            } else {
                try {
                    const r = await methods.build_ride_queue(pathParams);
                    summary.paths.queue = { built: r.built, cost: r.costFormatted, reachesNetwork: r.queueReachesParkNetwork };
                    spent += r.cost || 0;
                } catch (e) {
                    summary.paths.queue = 'failed: ' + e.message;
                }
                try {
                    const r = await methods.connect_ride_exit(pathParams);
                    summary.paths.exit = r.alreadyConnected ? 'already connected'
                        : { built: r.built, cost: r.costFormatted, connected: r.exitConnected };
                    spent += r.cost || 0;
                } catch (e) {
                    summary.paths.exit = 'failed: ' + e.message;
                }
            }
        }

        await applyRideSettings(rideId, params, flags, summary);
        summary.totalCost = spent;
        summary.totalCostFormatted = formatMoney(spent);
        return summary;
    };

    /**
     * Why a ride's ticket price would be ignored, or null. Rides (not shops) only charge when the park has free
     * entry or unlocked prices, and nothing charges in a no-money park (Park::RidePricesUnlocked, RideGetPrice).
     */
    function priceLockReason(ride) {
        const flag = name => {
            try {
                return park.getFlag(name);
            } catch (e) {
                return false;
            }
        };
        if (flag('noMoney')) return 'this park has no money, so nothing charges';
        if (ride.classification === 'ride' && !flag('freeParkEntry') && !flag('unlockAllPrices')) {
            return 'this park charges for entry, so ride tickets are free (only shops and stalls can be priced)';
        }
        return null;
    }

    /** Rejects a bad status before anything is built (applyRideSettings runs after building). */
    function checkStatusParam(params) {
        if (params.status !== undefined && params.status !== null && !(params.status in RIDE_STATUS)) {
            fail('"status" must be one of: ' + Object.keys(RIDE_STATUS).join(', ') + '.');
        }
    }

    /** Optional price and status changes after building. */
    async function applyRideSettings(rideId, params, flags, summary) {
        if (isNumber(params.price)) {
            const locked = priceLockReason(map.getRide(rideId));
            if (locked) {
                summary.price = 'not set: ' + locked;
            } else {
                const r = await executeAction('ridesetprice', { ride: rideId, price: Math.round(params.price), isPrimaryPrice: true, flags: flags });
                summary.price = r.error === 0 ? formatMoney(Math.round(params.price)) : 'failed: ' + describeResult(r);
            }
        }
        if (params.open || params.status) {
            const status = params.status || 'open';
            const r = await executeAction('ridesetstatus', { ride: rideId, status: RIDE_STATUS[status], flags: flags });
            summary.status = r.error === 0 ? status : 'could not set ' + status + ': ' + describeResult(r);
        }
    }

    methods.set_ride_status = async params => {
        const ride = getRideOrFail(params.rideId);
        const status = params.status;
        if (!(status in RIDE_STATUS)) fail('"status" must be one of: ' + Object.keys(RIDE_STATUS).join(', ') + '.');
        const res = await executeAction('ridesetstatus', { ride: ride.id, status: RIDE_STATUS[status], flags: 0 });
        if (res.error !== 0) fail('Could not set "' + ride.name + '" to ' + status + ': ' + describeResult(res));
        log('Set ' + ride.name + ' to ' + status);
        return { ride: ride.name, status: map.getRide(ride.id).status };
    };

    methods.set_ride_price = async params => {
        const ride = getRideOrFail(params.rideId);
        const price = requireInt(params, 'price');
        const locked = params.secondary ? null : priceLockReason(ride);
        if (locked) fail('The price of "' + ride.name + '" cannot be changed: ' + locked + '.');
        const res = await executeAction('ridesetprice', {
            ride: ride.id, price: price, isPrimaryPrice: params.secondary ? false : true, flags: 0,
        });
        if (res.error !== 0) fail('Could not set the price: ' + describeResult(res));
        return { ride: ride.name, price: formatMoney(price) };
    };

    methods.demolish_ride = async params => {
        const ride = getRideOrFail(params.rideId);
        const name = ride.name;
        const res = await demolishRide(ride.id, buildFlags(params));
        if (res.error !== 0) fail('Could not demolish "' + name + '": ' + describeResult(res));
        log('Demolished ' + name);
        return { demolished: name, refund: formatMoney(-(res.cost || 0)) };
    };

    const TURN_NAMES = ['none', 'half right', 'right', 'sharp right', 'reverse', 'sharp left', 'left', 'half left'];

    /**
     * Offset from a piece's start to the next piece's start: tiles forward/right (along the axes of direction 0,
     * so for pieces that start diagonally "forward" is still the x axis), change in z, and the change of heading.
     */
    function pieceMove(seg) {
        const eighths = d => (d & 3) * 2 + ((d & 4) ? 1 : 0);
        const endsDiagonal = (seg.endDirection & 4) !== 0;
        const endHeading = seg.endDirection & 3;
        // Pieces that end straight step one tile on along their end heading; diagonal ones do not.
        const nx = seg.endX / TILE_SIZE + (endsDiagonal ? 0 : DIR_DX[endHeading]);
        const ny = seg.endY / TILE_SIZE + (endsDiagonal ? 0 : DIR_DY[endHeading]);
        const move = {
            forward: -nx,
            right: ny,
            up: seg.endZ - seg.beginZ,
            turn: TURN_NAMES[(eighths(seg.endDirection) - eighths(seg.beginDirection) + 8) & 7],
        };
        if (seg.beginDirection & 4) move.startsDiagonal = true;
        if (endsDiagonal) move.endsDiagonal = true;
        return move;
    }

    /** Turns agent-supplied pieces (names, ids or objects) into layout track elements. */
    function normaliseLayoutPieces(pieces) {
        if (!Array.isArray(pieces) || pieces.length === 0) fail('"pieces" must be a non-empty array of track pieces.');
        return pieces.map((p, i) => {
            const spec = typeof p === 'object' && p !== null ? p : { type: p };
            let type = spec.type;
            if (typeof type === 'string') {
                let idx = TRACK_TYPE_NAMES.indexOf(type);
                if (idx < 0) idx = TRACK_TYPE_NAMES.findIndex(n => n.toLowerCase() === type.toLowerCase());
                if (idx < 0) fail('Unknown track piece "' + type + '" at position ' + i + '. list_track_pieces shows valid names.');
                type = idx;
            }
            if (!isNumber(type) || !trackSegment(type)) fail('Invalid track piece at position ' + i + '.');
            return {
                type: type,
                chain: !!spec.chain,
                inverted: !!spec.inverted,
                brakeSpeed: isNumber(spec.brakeSpeed) ? spec.brakeSpeed : 2,
                seatRotation: isNumber(spec.seatRotation) ? spec.seatRotation : 4,
                colourScheme: isNumber(spec.colourScheme) ? spec.colourScheme : 0,
                station: 0,
            };
        });
    }

    /** Track pieces a ride type may use (its enabled track groups, as the construction window offers). */
    /**
     * Can this ride type have chain lifts? Roller coasters can (the game takes a chain on any piece that allows one,
     * even for types whose lift is normally curved or on the inverted track); other rides only if their track has
     * lift hills, as the construction window offers (not car rides, ghost trains, mini golf and the like).
     */
    function rideHasChainLift(rideType) {
        const info = rideTypeInfo(rideType);
        if (info && (info.category === 'rollercoaster' || info.groups.includes(TRACK_GROUPS.indexOf('liftHill')))) return true;
        try {
            return !!cheats.enableChainLiftOnAllTrack;
        } catch (e) {
            return false;
        }
    }

    function allowedPieceTypes(rideType) {
        const info = rideTypeInfo(rideType);
        if (!info) return new Set();
        const groups = new Set(info.groups);
        let allDrawable = false;
        try {
            allDrawable = !!cheats.enableAllDrawableTrackPieces;
        } catch (e) {
            allDrawable = false;
        }
        if (allDrawable) info.extraGroups.forEach(g => groups.add(g));
        const out = new Set();
        for (let t = 0; t < TRACK_TYPE_NAMES.length; t++) {
            const seg = trackSegment(t);
            if (seg && groups.has(seg.trackGroup)) out.add(t);
        }
        if (info.kind === 'tracked') STATION_TRACK_TYPES.forEach(t => out.add(t));
        return out;
    }

    /**
     * Geometry report for a layout: where it ends, whether it closes into a circuit and whether consecutive
     * pieces join (matching slope and banking).
     */
    function checkLayout(elements, allowed, chainLift) {
        const walked = walkLayout(elements, 0);
        const problems = [];
        for (let i = 1; i < walked.pieces.length; i++) {
            const a = walked.pieces[i - 1].seg;
            const b = walked.pieces[i].seg;
            if (a.endSlope !== b.beginSlope || a.endBank !== b.beginBank) {
                problems.push('piece ' + i + ' (' + b.name + ') does not join ' + a.name + ' (slope/bank ' + a.endSlope + '/'
                    + a.endBank + ' vs ' + b.beginSlope + '/' + b.beginBank + ')');
            }
            if (walked.pieces[i].el.chain && !b.allowsChainLift) problems.push('piece ' + i + ' (' + b.name + ') cannot have a chain lift');
        }
        if (chainLift === false) {
            walked.pieces.forEach((p, i) => {
                if (p.el.chain) problems.push('piece ' + i + ' (' + p.seg.name + ') has a chain lift, which this ride type cannot have');
            });
        }
        if (allowed) {
            walked.pieces.forEach((p, i) => {
                if (!allowed.has(p.el.type)) problems.push('piece ' + i + ' (' + p.seg.name + ') is not available for this ride type');
            });
        }
        const end = walked.end;
        const closes = end.x === 0 && end.y === 0 && end.z === 0 && (end.direction & 7) === 0;
        if (closes && walked.pieces.length > 1) {
            const first = walked.pieces[0].seg;
            const last = walked.pieces[walked.pieces.length - 1].seg;
            if (last.endSlope !== first.beginSlope || last.endBank !== first.beginBank) {
                problems.push('the last piece does not join the first (slope/bank mismatch)');
            }
        }
        const stations = walked.pieces.filter(p => STATION_TRACK_TYPES.includes(p.el.type)).length;
        const shape = layoutTiles(walked, [], 0);
        return {
            pieces: elements.length,
            stationPieces: stations,
            closesCircuit: closes,
            end: {
                x: end.x / TILE_SIZE, y: end.y / TILE_SIZE, z: end.z, direction: end.direction & 3,
                diagonal: (end.direction & 4) !== 0,
            },
            size: { width: shape.maxX - shape.minX + 1, length: shape.maxY - shape.minY + 1 },
            heightRange: {
                min: Math.min(...walked.pieces.map(p => p.z)),
                max: Math.max(...walked.pieces.map(p => p.z)),
            },
            problems: problems,
        };
    }

    methods.place_track_layout = async params => {
        let layout = params.layout;
        if (!layout && params.pieces) {
            layout = { name: params.name, trackElements: normaliseLayoutPieces(params.pieces), entrances: [] };
        }
        if (!layout || typeof layout !== 'object') fail('Give "pieces" (a custom layout) or a decoded "layout".');
        let option = null;
        if (params.pieces) {
            // Custom layouts must form a proper circuit before anything is placed.
            option = resolveRideOption(params, ['tracked', 'tower']);
            const report = params.allowAnyPiece ? checkLayout(layout.trackElements, null)
                : checkLayout(layout.trackElements, allowedPieceTypes(option.rideType), rideHasChainLift(option.rideType));
            const kind = rideTypeInfo(option.rideType).kind;
            if (kind === 'tracked' && report.stationPieces === 0) report.problems.push('the layout has no station pieces');
            if (kind === 'tracked' && !report.closesCircuit && !params.allowOpenCircuit) {
                report.problems.push('the layout does not return to its start (ends at ' + JSON.stringify(report.end) + ')');
            }
            if (report.problems.length > 0) fail('The layout is not buildable as given.', report);
        }
        return buildLayout(layout, params, option);
    };

    methods.check_track_layout = params => {
        const elements = normaliseLayoutPieces(params.pieces);
        if (params.ride !== undefined || params.object !== undefined || isNumber(params.rideType)) {
            const rideType = resolveRideOption(params, ['tracked', 'tower']).rideType;
            return checkLayout(elements, allowedPieceTypes(rideType), rideHasChainLift(rideType));
        }
        return checkLayout(elements, null);
    };

    methods.list_track_pieces = params => {
        const option = resolveRideOption(params, ['tracked', 'tower']);
        const allowed = allowedPieceTypes(option.rideType);
        const pieces = [];
        for (const t of allowed) {
            const seg = trackSegment(t);
            if (!seg) continue;
            if (params.group && TRACK_GROUPS[seg.trackGroup] !== params.group) continue;
            pieces.push({
                name: seg.name,
                type: t,
                group: TRACK_GROUPS[seg.trackGroup],
                // Where the next piece starts relative to this one, in tiles, seen along its heading.
                move: pieceMove(seg),
                slope: [seg.beginSlope, seg.endSlope],
                bank: [seg.beginBank, seg.endBank],
                chainLift: seg.allowsChainLift,
                inversion: seg.isInversion,
            });
        }
        pieces.sort((a, b) => a.type - b.type);
        return { ride: option.name, rideType: option.rideTypeName, count: pieces.length, pieces: params.namesOnly ? pieces.map(p => p.name) : pieces };
    };

    /**
     * Generates a coaster for one ride option. Deterministic for a given seed and options: the search stops after
     * a fixed number of attempts or search steps, never because of the clock (the time limit is only a safety net
     * for very slow machines, and is reported if it is ever hit).
     */
    function generateCoaster(chosen, params, style, baseSeed, deadline) {
        const s = COASTER_STYLES[style];
        const maxZ = Math.min(chosen.info.maxHeight * 16 - 32, 1500);
        const stationLength = Math.max(3, Math.min(12, optInt(params, 'stationLength', 6)));
        const opts = {
            style: style,
            length: Math.max(12, Math.min(64, optInt(params, 'maxLength', s.size[0]))),
            width: Math.max(6, Math.min(64, optInt(params, 'maxWidth', s.size[1]))),
            liftHeight: Math.max(2, Math.min(optInt(params, 'liftHeight', s.lift), Math.floor(maxZ / 16) - 2)),
            stationLength: stationLength,
            inversions: params.inversions !== false,
            maxZ: maxZ,
            targets: coasterTargets(chosen.option.rideType),
            massFactor: coasterMassFactor(chosen.option, stationLength),
            noUpstops: coasterNoUpstops(chosen.option),
            debug: !!params.debug,
            budget: { used: 0, max: 60000, deadline: deadline, timedOut: false },
        };
        // Without a size from the caller, a ride type that needs a long lift or drop gets a bigger area if needed.
        const sizes = isNumber(params.maxLength) || isNumber(params.maxWidth) ? [[opts.length, opts.width]]
            : [[opts.length, opts.width], [opts.length + 6, opts.width + 4], [opts.length + 12, opts.width + 6]];
        // Ride types that must be long to rate well (e.g. 370 m for the wooden coaster) start with more room.
        if (sizes.length > 1 && opts.targets.lengthTiles > 60) sizes.shift();
        // Several attempts; keep the first that meets every rating requirement, else the one missing the fewest.
        let best = null;
        const why = {};
        const outOfBudget = () => opts.budget.timedOut || opts.budget.used >= opts.budget.max;
        for (const [length, width] of sizes) {
            if (best || outOfBudget()) break;
            opts.length = length;
            opts.width = width;
            let drafted = 0;
            for (let attempt = 0; attempt < 40 && drafted < 12; attempt++) {
                if (outOfBudget()) break;
                const d = draftCoaster(chosen.types, chosen.info, opts, makeRng((baseSeed + attempt * 7919) >>> 0), why);
                if (!d) continue;
                drafted++;
                const misses = checkTargets(d, opts.targets);
                if (!best || misses.length < best.misses.length) best = { draft: d, misses: misses, length: length, width: width };
                if (misses.length === 0) break;
            }
        }
        return { best: best, opts: opts, why: why };
    }

    methods.design_roller_coaster = async params => {
        const style = params.style || 'moderate';
        if (!COASTER_STYLES[style]) fail('"style" must be gentle, moderate or intense.');
        checkStatusParam(params);
        const named = params.ride !== undefined || params.object !== undefined || isNumber(params.rideType);
        const candidates = coasterCandidates(params, style);
        if (candidates.length === 0) {
            fail(named
                ? 'That ride cannot be generated: it needs a chain lift on 25 degree slopes, normal station pieces and '
                    + 'turns. Build it piece by piece with build_custom_track instead.'
                : 'This park has no roller coaster with a chain lift researched yet.');
        }
        const baseSeed = isNumber(params.seed) ? Math.floor(params.seed) >>> 0 : Math.floor(Math.random() * 0x7FFFFFFF);
        // Generation runs on the game thread; the deadline only guards against a very slow machine.
        const deadline = Date.now() + 10000;
        let chosen = null;
        let generated = null;
        const tried = [];
        // A named ride must work as asked; otherwise fall back to the next best coaster the park has.
        for (const candidate of named ? candidates.slice(0, 1) : candidates.slice(0, 4)) {
            generated = generateCoaster(candidate, params, style, baseSeed, deadline);
            tried.push(candidate.option.name);
            if (generated.best) {
                chosen = candidate;
                break;
            }
            if (generated.opts.budget.timedOut) break;
        }
        if (!chosen) {
            const o = generated.opts;
            if (o.budget.timedOut) {
                fail('Ran out of time designing ' + tried.join(', ') + ' (this machine is slow for it). Try a smaller area '
                    + '(maxLength/maxWidth) or a lower liftHeight.', o.debug ? { failedAt: generated.why } : undefined);
            }
            if (o.budget.used >= o.budget.max) {
                // The search gave up before trying every area, so do not blame the room.
                fail('Could not find a complete circuit for ' + tried.join(' or ') + ' within the search limit (last tried '
                    + o.length + 'x' + o.width + ' tiles). Try another seed, a lower liftHeight, or a different area '
                    + '(maxLength/maxWidth).', o.debug ? { failedAt: generated.why } : undefined);
            }
            fail('Could not fit a complete circuit for ' + tried.join(' or ') + ' in ' + o.length + 'x' + o.width
                + ' tiles. Allow more room (maxLength/maxWidth) or a lower liftHeight.', o.debug ? { failedAt: generated.why } : undefined);
        }
        const best = generated.best;
        const draft = best.draft;
        const report = checkLayout(draft.els, allowedPieceTypes(chosen.option.rideType));
        if (report.problems.length > 0 || !report.closesCircuit) fail('The generated layout failed its own checks.', report);
        const design = {
            ride: chosen.option.name,
            style: style,
            seed: baseSeed,
            pieces: draft.els.length,
            // Along the same axes as maxLength/maxWidth (the generator lays the length out along x).
            size: { length: report.size.width, width: report.size.length },
            // In land steps, like the liftHeight option.
            liftHeight: draft.liftHeight / 16,
            firstDrop: draft.firstDrop / 16,
            inversions: draft.inversions,
            drops: draft.drops,
            lengthTiles: Math.round(draft.length),
            features: draft.features,
        };
        if (generated.opts.debug) design.debug = generated.why;
        if (best.misses.length > 0) {
            design.mayMissRequirements = best.misses;
            design.note = 'This ride type rates poorly without these; a larger area (maxLength/maxWidth) usually helps.';
        }
        const pieces = draft.els.map(e => {
            const name = TRACK_TYPE_NAMES[e.type];
            if (e.chain) return { type: name, chain: true };
            if (name === 'brakes') return { type: name, brakeSpeed: e.brakeSpeed };
            return name;
        });
        if (params.previewOnly) {
            return { design: design, pieces: pieces, note: 'Not built. Pass these pieces to build_custom_track (with the same '
                + 'ride, and trains: 1 since the layout has no block brakes) to build them, or call design_roller_coaster '
                + 'again with the same seed and options.' };
        }
        const layout = {
            name: typeof params.name === 'string' && params.name ? params.name : null,
            trackElements: draft.els,
            entrances: [],
            settings: { numberOfTrains: 1 },
        };
        const result = await buildLayout(layout, params, chosen.option);
        delete result.design;
        return Object.assign(result, { design: design }, params.dryRun ? { pieces: pieces } : {});
    };

    methods.list_methods = () => Object.keys(methods).sort();

    // ------------------------------------------------------------------
    // Socket server
    // ------------------------------------------------------------------

    const connections = new Set();
    let server = null;
    let listeningPort = null;

    function writeChunked(conn, text) {
        conn.outbox.push(text);
        flushOutbox(conn);
    }

    function flushOutbox(conn) {
        if (conn.closed || conn.flushScheduled) return;
        let budget = WRITE_CHUNK;
        while (conn.outbox.length > 0 && budget > 0) {
            let chunk = conn.outbox[0];
            if (chunk.length > budget) {
                conn.outbox[0] = chunk.substring(budget);
                chunk = chunk.substring(0, budget);
            } else {
                conn.outbox.shift();
            }
            budget -= chunk.length;
            let partial;
            try {
                partial = conn.socket.write(chunk);
            } catch (e) {
                partial = true;
            }
            if (partial) {
                // The game's socket API cannot tell us how much was sent, so the stream is now unusable.
                log('Write to client failed; closing connection.');
                closeConnection(conn);
                return;
            }
        }
        if (conn.outbox.length > 0) {
            conn.flushScheduled = true;
            context.setTimeout(() => {
                conn.flushScheduled = false;
                flushOutbox(conn);
            }, 0);
        }
    }

    function closeConnection(conn) {
        if (conn.closed) return;
        conn.closed = true;
        connections.delete(conn);
        try {
            conn.socket.destroy();
        } catch (e) {
            // ignore
        }
        refreshStatusWindow();
    }

    function sendResponse(conn, payload) {
        let text;
        try {
            text = JSON.stringify(payload);
        } catch (e) {
            text = JSON.stringify({ id: payload.id, error: { message: 'Result could not be serialised: ' + e } });
        }
        // Escape non-ASCII so chunked writes can never split a multi-byte character.
        text = text.replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
        writeChunked(conn, text + '\n');
    }

    async function handleLine(conn, line) {
        let request;
        try {
            request = JSON.parse(line);
        } catch (e) {
            sendResponse(conn, { id: null, error: { message: 'Invalid JSON: ' + e.message } });
            return;
        }
        const id = request.id === undefined ? null : request.id;
        const token = getSetting('token', '');
        if (token && request.token !== token) {
            sendResponse(conn, { id: id, error: { message: 'Invalid or missing token.' } });
            return;
        }
        const method = methods[request.method];
        if (!method) {
            sendResponse(conn, { id: id, error: { message: 'Unknown method "' + request.method + '".', methods: Object.keys(methods) } });
            return;
        }
        try {
            const params = request.params && typeof request.params === 'object' ? request.params : {};
            const result = await method(params);
            sendResponse(conn, { id: id, result: result === undefined ? null : result });
        } catch (e) {
            const error = { message: e && e.message ? e.message : String(e) };
            if (e instanceof RpcError) {
                if (e.data) error.data = e.data;
            } else {
                console.log('[' + PLUGIN_NAME + '] ' + request.method + ' failed: ' + (e && e.stack ? e.stack : e));
            }
            sendResponse(conn, { id: id, error: error });
        }
    }

    function onConnection(socket) {
        const conn = { socket: socket, buffer: '', outbox: [], chain: Promise.resolve(), closed: false, flushScheduled: false };
        connections.add(conn);
        log('Client connected (' + connections.size + ' active)');
        socket.setNoDelay(true);
        socket.on('data', data => {
            conn.buffer += data;
            let newline;
            while ((newline = conn.buffer.indexOf('\n')) >= 0) {
                const line = conn.buffer.substring(0, newline).trim();
                conn.buffer = conn.buffer.substring(newline + 1);
                if (line.length === 0) continue;
                // Requests on one connection run one at a time, in order.
                conn.chain = conn.chain.then(() => handleLine(conn, line)).catch(e => {
                    console.log('[' + PLUGIN_NAME + '] request error: ' + e);
                });
            }
            if (conn.buffer.length > 4 * 1024 * 1024) {
                log('Request too large; closing connection.');
                closeConnection(conn);
            }
        });
        socket.on('close', () => {
            conn.closed = true;
            connections.delete(conn);
            log('Client disconnected (' + connections.size + ' active)');
        });
        socket.on('error', err => {
            log('Socket error: ' + err);
        });
    }

    function startServer() {
        stopServer();
        const port = getSetting('port', DEFAULT_PORT);
        try {
            server = network.createListener();
            server.on('connection', onConnection);
            server.listen(port, '127.0.0.1');
            listeningPort = port;
            log('Listening on 127.0.0.1:' + port);
        } catch (e) {
            server = null;
            listeningPort = null;
            log('Could not listen on port ' + port + ': ' + e);
        }
        refreshStatusWindow();
    }

    function stopServer() {
        for (const conn of Array.from(connections)) closeConnection(conn);
        if (server) {
            try {
                server.close();
            } catch (e) {
                // ignore
            }
        }
        server = null;
        listeningPort = null;
    }

    // ------------------------------------------------------------------
    // In-game status window
    // ------------------------------------------------------------------

    const WINDOW_CLASS = 'ai-control-plane-status';

    function statusLines() {
        const lines = [];
        lines.push(listeningPort !== null ? 'Listening on 127.0.0.1:' + listeningPort : 'Not listening');
        lines.push('Connected clients: ' + connections.size);
        return lines;
    }

    function refreshStatusWindow() {
        if (typeof ui === 'undefined') return;
        const w = ui.getWindow(WINDOW_CLASS);
        if (!w) return;
        try {
            const lines = statusLines();
            w.findWidget('status0').text = lines[0];
            w.findWidget('status1').text = lines[1];
            w.findWidget('log').items = activityLog.slice().reverse();
            w.findWidget('eval').isChecked = !!getSetting('allowEval', false);
        } catch (e) {
            // Window may be mid-construction.
        }
    }

    function openStatusWindow() {
        const existing = ui.getWindow(WINDOW_CLASS);
        if (existing) {
            existing.bringToFront();
            return;
        }
        const width = 340;
        const height = 230;
        const lines = statusLines();
        ui.openWindow({
            classification: WINDOW_CLASS,
            title: PLUGIN_NAME,
            width: width,
            height: height,
            widgets: [
                { type: 'label', name: 'status0', x: 8, y: 20, width: width - 16, height: 12, text: lines[0] },
                { type: 'label', name: 'status1', x: 8, y: 34, width: width - 16, height: 12, text: lines[1] },
                {
                    type: 'listview', name: 'log', x: 8, y: 50, width: width - 16, height: height - 96,
                    scrollbars: 'vertical', items: activityLog.slice().reverse(),
                },
                {
                    type: 'checkbox', name: 'eval', x: 8, y: height - 42, width: width - 16, height: 12,
                    text: 'Allow agents to run arbitrary plugin JavaScript (eval)',
                    isChecked: !!getSetting('allowEval', false),
                    onChange: checked => setSetting('allowEval', checked),
                },
                {
                    type: 'button', name: 'restart', x: 8, y: height - 24, width: 120, height: 14,
                    text: 'Restart server', onClick: () => startServer(),
                },
            ],
        });
    }

    // ------------------------------------------------------------------
    // Startup
    // ------------------------------------------------------------------

    function main() {
        if (typeof network === 'undefined' || typeof network.createListener !== 'function') {
            console.log('[' + PLUGIN_NAME + '] This build of OpenRCT2 has no socket support; the control plane cannot start.');
            return;
        }
        context.subscribe('map.changed', () => {
            invalidateParkEntrances();
            invalidateWaterCache();
        });
        context.subscribe('action.execute', e => {
            if (e.action === 'parkentranceplace' || e.action === 'parkentranceremove') invalidateParkEntrances();
            if (e.action === 'waterraise' || e.action === 'waterlower' || e.action === 'watersetheight') invalidateWaterCache();
        });
        startServer();
        if (typeof ui !== 'undefined') {
            try {
                ui.registerMenuItem(PLUGIN_NAME, () => {
                    try {
                        openStatusWindow();
                    } catch (e) {
                        console.log('[' + PLUGIN_NAME + '] Could not open window: ' + e);
                    }
                });
            } catch (e) {
                console.log('[' + PLUGIN_NAME + '] Could not register menu item: ' + e);
            }
        }
    }

    registerPlugin({
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        authors: ['OpenRCT2 AI Control Plane contributors'],
        type: 'intransient',
        licence: 'GPL-3.0',
        minApiVersion: 111,
        targetApiVersion: 123,
        main: main,
    });
})();
