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
    //                       maxHeight, liftSpeedMin, liftSpeedMax, specialType]
    const RIDE_TYPE_DATA = [
        ["spiral_rc",2,1,1309689527,5466,[1,2,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,41,42,46,68,87,88,89],[3,49],19,7,7,0],
        ["stand_up_rc",2,1,1309689527,8394074,[1,2,3,6,7,8,9,11,13,15,16,17,19,20,22,23,24,25,26,27,28,29,34,35,41,42,43,68,69,70,79,81,82,87,88,89],[10,12,31,32,44,47,71,72],25,4,6,0],
        ["suspended_swinging_rc",2,1,1309689527,136282,[1,2,3,8,9,11,13,15,16,17,26,27,28,41,68,87,88,89],[],24,4,6,0],
        ["inverted_rc",2,1,1309689527,8525146,[1,2,3,6,7,8,9,11,12,13,15,16,17,18,19,20,24,25,26,27,28,29,31,34,35,41,42,43,44,47,68,69,70,79,80,81,82,85,86,87,88,89],[10,32,49,71,72],42,5,7,0],
        ["junior_rc",2,1,3457173175,8394074,[1,2,3,5,6,8,10,11,13,15,16,17,22,23,28,41,49,81,82,87],[9,29,68,88,89],12,4,6,0],
        ["miniature_railway",0,1,1241530932,68914,[1,2,8,13,15,16,17,87],[],7,5,5,0],
        ["monorail",0,1,1241530935,3378,[1,2,8,13,15,16,17,87],[],8,5,5,0],
        ["mini_suspended_rc",2,1,1309689525,136282,[1,2,3,8,13,15,16,17,87],[],10,4,5,0],
        ["boat_hire",4,1,1308641349,18,[1,2,13,14,15,16,17],[],255,5,5,10],
        ["wooden_wild_mouse",2,1,3457173173,5210,[1,2,3,4,8,9,10,14,15,68],[],14,4,5,0],
        ["steeplechase",2,1,1309689527,5210,[1,2,3,8,13,15,16,17,26,27,28,41,81,82,87],[],14,4,5,0],
        ["car_ride",1,1,3390063143,9266,[1,2,8,14,15,48],[9,56,68],6,5,5,0],
        ["launched_freefall",3,66,1242841871,5138,[21],[],255,5,5,0],
        ["bobsleigh_rc",2,1,1309689527,5466,[1,2,3,6,8,13,15,16,22,23,28,29,41],[],19,4,5,0],
        ["observation_tower",1,66,1241792783,9234,[21],[],255,5,5,0],
        ["looping_rc",2,1,1309689527,142611802,[1,2,3,6,7,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,35,41,42,43,49,68,81,82,87,88,89],[10,18,19,20,31,32,34,44,47,69,70,71,72],35,4,6,0],
        ["dinghy_slide",4,1,1309693623,5202,[1,2,3,8,9,13,15,16,68],[],15,4,5,0],
        ["mine_train_rc",2,1,1309689527,8394074,[1,2,3,6,8,9,11,13,15,16,17,22,23,28,29,41,43,68,81,82,87,88,89],[],21,4,6,0],
        ["chairlift",0,1,1241530405,67251250,[1,2,8,14],[],40,5,5,0],
        ["corkscrew_rc",2,1,1309689527,8394074,[1,2,3,6,7,8,9,11,12,13,15,16,17,19,20,22,23,24,25,26,27,28,29,34,35,41,42,43,49,68,69,70,79,81,82,85,87,88,89],[10,18,31,32,44,47,71,72,86],28,4,6,0],
        ["maze",1,101,138684428,1048592,[],[],6,5,5,1],
        ["spiral_slide",1,258,796943,36882,[],[],15,5,5,3],
        ["go_karts",3,1,1242826757,2101266,[1,2,8,11,13,14,15,16,17,79,87],[9,43,68,88,89],8,5,5,0],
        ["log_flume",4,1,1242580535,5234,[1,2,8,9,13,15,29,36],[],10,5,5,0],
        ["river_rapids",4,1,1242842677,5234,[1,2,8,14,29,56,60,61],[],9,5,5,0],
        ["dodgems",1,259,34343183,33562643,[],[],9,5,5,0],
        ["swinging_ship",3,261,34423053,37010,[],[],12,5,5,0],
        ["swinging_inverter_ship",3,263,34423055,37010,[],[],15,5,5,0],
        ["food_stall",5,262,9316617,32768,[],[],12,5,5,0],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["drink_stall",5,262,17705225,32768,[],[],12,5,5,0],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["shop",5,262,928009,32768,[],[],12,5,5,0],
        ["merry_go_round",1,266,34423048,16814227,[],[],12,5,5,0],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["information_kiosk",5,264,928009,32768,[],[],12,5,5,0],
        ["toilets",5,262,7219464,32768,[],[],12,5,5,4],
        ["ferris_wheel",1,265,34406665,41106,[],[],16,5,5,0],
        ["motion_simulator",3,258,34423048,41106,[],[],12,5,5,8],
        ["3d_cinema",3,266,38617352,32914,[],[],12,5,5,0],
        ["top_spin",3,266,34423055,37010,[],[],16,5,5,0],
        ["space_rings",1,266,34343176,41106,[],[],16,5,5,9],
        ["reverse_freefall_rc",2,1,1309722279,8393810,[1,2,4,29,39],[],255,5,5,0],
        ["lift",0,66,1510228237,3090,[21],[],255,5,5,0],
        ["vertical_drop_rc",2,1,1309689527,5210,[0,1,2,3,4,6,7,8,9,10,11,12,13,15,16,17,20,22,23,24,25,26,27,28,29,31,34,35,41,42,44,62,68,69,70,71,72,79,81,82,86,87,88,89],[18,19,32,33,34,43,47,49,85],55,4,5,0],
        ["cash_machine",5,262,928008,32768,[],[],12,5,5,5],
        ["twist",3,266,34423048,37010,[],[],12,5,5,0],
        ["haunted_house",1,266,5062920,32914,[],[],16,5,5,0],
        ["first_aid",5,262,7219464,32768,[],[],12,5,5,6],
        ["circus",1,266,38617352,32913,[],[],12,5,5,0],
        ["ghost_train",1,1,3390064295,267378,[1,2,8,14,15,28,48],[],8,5,5,0],
        ["twister_rc",2,1,1309689527,8394074,[0,1,2,3,6,7,8,9,11,12,13,15,16,17,18,19,20,22,23,24,25,26,27,28,29,31,32,33,34,35,41,42,43,44,47,49,68,69,70,71,72,79,81,82,85,86,87,88,89],[4,10,62],40,5,8,0],
        ["wooden_rc",2,1,1309689527,8394074,[0,1,2,3,6,7,8,9,11,12,13,15,16,17,22,23,28,29,30,34,35,41,42,43,68,70,81,82,87,88,89],[49],41,5,7,0],
        ["side_friction_rc",2,1,1309689527,8394074,[1,2,3,8,9,13,15,16,17,28,68,87,88,89],[],18,3,5,0],
        ["steel_wild_mouse",2,1,3457173175,5210,[1,2,3,4,8,9,10,11,14,15,28,41,68],[67],16,4,6,0],
        ["multi_dimension_rc",2,1,1309689527,12588382,[1,2,3,6,8,9,13,15,16,17,22,23,24,25,26,27,28,29,31,41,50,52,53,68,81,82,87,88,89],[],40,4,6,0],
        ["multi_dimension_rc_alt",255,1,1309689527,541069314,[],[],40,4,6,0],
        ["flying_rc",2,1,1309689527,21854,[1,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,31,35,41,42,50,52,57,68,73,79,81,82,87,88,89],[2,7,10,33,43,49,75,77,85],30,4,6,0],
        ["flying_rc_alt",255,1,1309689527,536891394,[],[],30,4,6,0],
        ["virginia_reel",2,1,1309689527,5210,[1,2,3,8,14,15],[],14,3,5,0],
        ["splash_boats",4,1,1242580535,9330,[1,2,8,9,13,16,29],[],16,5,5,0],
        ["mini_helicopters",1,1,3390063143,9266,[1,2,8,14,15],[48],7,5,5,0],
        ["lay_down_rc",2,1,1309689527,5470,[1,2,3,6,7,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,35,41,42,43,50,57,63,68,79,81,82,85,87,88,89],[10,49,77],26,4,6,0],
        ["suspended_monorail",0,1,1241530935,134450,[1,2,8,13,15,16,17,87],[],12,5,5,0],
        ["lay_down_rc_alt",255,1,1309689527,536875010,[],[],26,4,6,0],
        ["reverser_rc",2,1,1846560439,5210,[1,2,3,8,13,15,16,28,38],[],18,3,5,0],
        ["heartline_twister_rc",2,1,1309689527,8393818,[1,2,3,4,8,9,37,65,68],[],22,4,6,0],
        ["mini_golf",1,1,1207961607,2105362,[1,2,8,14,66],[],7,5,5,2],
        ["giga_rc",2,1,1309689527,8394586,[1,2,3,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,31,35,41,42,43,44,45,68,79,81,82,85,87,88,89],[7,10,19,20,32,33,34,47,49,69,70,71,72,84,86],86,5,8,0],
        ["roto_drop",3,66,1242841871,5266,[21],[],255,5,5,0],
        ["flying_saucers",1,259,34343179,4243,[],[],9,5,5,0],
        ["crooked_house",1,266,5062920,32914,[],[],16,5,5,0],
        ["monorail_cycles",1,1,1242581543,8210,[1,2,13,15,16],[],5,5,5,0],
        ["compact_inverted_rc",2,1,1309689527,268571994,[1,2,3,6,7,8,9,11,12,13,15,16,17,18,19,20,24,25,28,29,31,41,68,81,82,87,88,89],[],27,4,6,0],
        ["water_coaster",2,1,1309693623,5210,[1,2,3,6,8,9,11,13,15,16,17,22,23,28,29,41,49,68,81,82,87,88,89],[10],18,4,6,0],
        ["air_powered_vertical_rc",2,1,1309689511,5210,[1,2,4,5,6,16,28,29,39,40],[49],255,5,5,0],
        ["inverted_hairpin_rc",2,1,1309689527,136282,[1,2,3,4,8,9,10,11,14,15,28,41,68],[],16,4,6,0],
        ["magic_carpet",3,257,34423055,37010,[],[],15,5,5,0],
        ["submarine_ride",4,1,1242579031,58,[1,2,14,15],[],255,5,5,0],
        ["river_rafts",4,1,1242579511,9266,[1,2,13,16],[8,9,29],12,5,5,0],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["enterprise",3,259,35471624,37010,[],[],16,5,5,7],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["inverted_impulse_rc",2,1,1309689527,8525146,[1,2,8,9,31,44,68],[],45,4,7,0],
        ["mini_rc",2,1,1309689527,8394074,[1,2,3,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,41,42,68,87,88,89],[46,49],16,4,6,0],
        ["mine_ride",2,1,1309689527,8394074,[1,2,6,8,13,15,16,17,22,23,24,25,26,27,29,87],[],13,5,5,0],
        ["invalid",255,1,0,536870912,[],[],12,5,5,0],
        ["lim_launched_rc",2,1,1309689527,8394074,[1,2,6,7,8,9,11,12,13,15,16,17,18,19,20,22,23,24,25,26,27,28,29,31,32,34,35,41,42,43,44,47,68,69,70,71,72,87,88,89],[10],35,4,6,0],
        ["hypercoaster",2,1,1309689527,8394074,[1,2,3,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,35,41,42,43,68,79,81,82,85,87,88,89],[7,10,18,19,20,31,32,34,44,47,49,69,70,71,72,86],55,4,6,0],
        ["hyper_twister",2,1,1309689527,8394074,[0,1,2,3,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,31,35,41,42,43,44,68,79,81,82,85,87,88,89],[4,7,10,18,19,20,32,33,34,47,49,62,69,70,71,72,86],61,5,8,0],
        ["monster_trucks",1,1,1242579495,9266,[1,2,8,9,14,15,56,68],[48],18,5,5,0],
        ["spinning_wild_mouse",2,1,1309689527,5210,[1,2,3,8,10,14,15,28,41,67],[4,9,11,68],16,4,6,0],
        ["classic_mini_rc",2,1,3457173175,8394074,[1,2,3,5,6,8,9,10,11,13,15,16,17,22,23,28,41,49,68,81,82,87,88,89],[29],15,4,6,0],
        ["hybrid_rc",2,1,1309689525,8394074,[0,1,2,3,4,6,8,9,11,12,13,15,16,17,22,23,24,25,26,27,28,29,31,32,33,35,41,42,43,44,47,68,71,72,79,81,82,83,87,88,89],[49],43,5,11,0],
        ["single_rail_rc",2,1,1309689527,8394074,[0,1,2,3,4,6,8,9,10,11,12,13,15,16,17,19,20,22,23,24,25,26,27,28,29,31,32,34,35,41,42,44,47,68,69,70,71,72,79,81,82,83,86,87,88,89],[43,85],28,5,8,0],
        ["alpine_rc",2,1,1309691429,528434,[0,1,2,3,6,8,10,11,13,15,16,17,23,25,27,87],[22,24,26],18,4,5,0],
        ["classic_wooden_rc",2,1,1309689527,8394074,[0,1,2,3,6,7,8,9,11,13,15,16,17,28,29,30,34,41,43,68,70,81,82,87,88,89],[12,49],24,3,5,0],
        ["classic_stand_up_rc",2,1,1309689527,8394074,[1,2,3,6,7,8,9,11,13,15,16,17,19,20,26,27,28,29,34,41,43,68,69,70,79,81,82,87,88,89],[10,12,31,32,44,47,71,72],30,4,6,0],
        ["lsm_rc",2,1,1309689527,8394586,[1,2,6,7,8,9,11,12,13,15,16,17,19,20,22,23,24,25,26,27,28,29,31,32,33,34,35,41,42,43,44,47,49,68,69,70,71,72,79,80,81,82,84,85,86,87,88,89],[3,10,45],33,5,5,0],
        ["classic_wooden_twister_rc",2,1,1309689527,8394074,[0,1,2,3,6,8,9,11,12,13,15,16,17,22,23,28,29,35,41,43,68,81,82,87,88,89],[7,30,34,49,70],24,3,5,0],
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
                    } else if (z < e.z + PATH_CLEARANCE && z + PATH_CLEARANCE + LAND_STEP > e.z) {
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
        const [name, category, startPiece, flagsLow, flagsHigh, groups, extraGroups, maxHeight, liftMin, liftMax, special] = row;
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
            special: special, kind: kind,
        };
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
    function rankAttachments(tc, points, networkField, z) {
        return points
            .map(p => {
                const front = tc.get(p.front.x, p.front.y);
                const ok = portalSpotOk(tc, p.x, p.y, z, p.front.x, p.front.y);
                const d = networkField ? networkField(p.front.x, p.front.y) : 0;
                const frontHasPath = !!(front && front.paths.some(q => !q.ghost));
                return Object.assign({ ok: ok, distance: d < 0 ? 999 : d, frontHasPath: frontHasPath }, p);
            })
            .filter(p => p.ok)
            .sort((a, b) => a.distance - b.distance);
    }

    function chooseEntranceAndExit(ranked) {
        // The entrance needs a free tile in front for its queue line; an exit may open straight onto a path.
        const entrance = ranked.find(p => !p.frontHasPath && p.distance >= 2) || ranked.find(p => !p.frontHasPath);
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
            length: seg.length,
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

    /** executeAction whose callback ran synchronously (inside a tick); null if the action was queued instead. */
    function executeActionNow(name, args) {
        let result = null;
        try {
            context.executeAction(name, args, res => {
                result = res;
            });
        } catch (e) {
            return { error: -2, errorMessage: String(e && e.message ? e.message : e) };
        }
        return result;
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
    function designEntrancePlacements(layout, rideId, ox, oy, baseZ, direction) {
        const out = [];
        for (const e of layout.entrances || []) {
            const r = rotate(e.x, e.y, direction);
            const x = ox + Math.floor(r.x / TILE_SIZE);
            const y = oy + Math.floor(r.y / TILE_SIZE);
            const dir = (direction + e.direction) & 3;
            const z = e.z === null || e.z === undefined ? null : e.z * 8 + baseZ;
            // The station is whatever station the track beside the entrance belongs to.
            let station = 0;
            const tile = map.getTile(x + DIR_DX[dir], y + DIR_DY[dir]);
            for (const el of tile.elements) {
                if (el.type === 'track' && el.ride === rideId && (z === null || el.baseZ === z)) {
                    station = el.station === null || el.station === undefined ? 0 : el.station;
                    break;
                }
            }
            const away = dir ^ 2;
            out.push({
                x: x, y: y, direction: dir, station: station, isExit: !!e.isExit, z: z,
                front: { x: x + DIR_DX[away], y: y + DIR_DY[away] },
            });
        }
        return out;
    }

    /** Can an entrance/exit stand on (x, y) at height z, with a path possible on the tile in front of it? */
    function portalSpotOk(tc, x, y, z, frontX, frontY) {
        const spot = tc.get(x, y);
        const front = tc.get(frontX, frontY);
        if (!spot || !spot.surface || !front || !front.surface) return false;
        const sandbox = isSandbox();
        if (!sandbox && !spot.surface.owned) return false;
        if (!sandbox && !front.surface.owned && !front.surface.rights) return false;
        if (spot.paths.length || spot.entrances.length || spot.largeScenery) return false;
        if (spot.tracks.some(t => t.z < z + 56 && t.clearanceZ > z)) return false;
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

    /** Entrance/exit spots along a placed layout's station platforms (used when a layout gives none). */
    function stationAttachmentPoints(walked, ox, oy) {
        const points = [];
        for (const p of portalPieces(walked)) {
            const fp = pieceFootprint(p.el.type);
            const tx = ox + Math.floor(p.x / TILE_SIZE);
            const ty = oy + Math.floor(p.y / TILE_SIZE);
            for (const a of attachmentPoints(p.el.type, fp, tx, ty, p.direction)) {
                a.station = 0;
                points.push(a);
            }
        }
        return points;
    }

    async function applyLayoutSettings(rideId, layout, option, flags, warnings) {
        const run = async (action, args, what, quiet) => {
            const res = await executeAction(action, Object.assign({ ride: rideId, flags: flags }, args));
            if (res.error !== 0 && !quiet) warnings.push(what + ': ' + describeResult(res));
        };
        const s = layout.settings || {};
        await run('ridesetvehicle', { type: 2, value: option.object, colour: 0 }, 'vehicle');
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
        (c.track || []).forEach((tc, i) => {
            if (!tc) return;
            ['main', 'additional', 'supports'].forEach((k, t) => {
                if (isNumber(tc[k])) run('ridesetappearance', { type: t, value: tc[k], index: i }, 'track colour');
            });
        });
        (c.vehicles || []).slice(0, 32).forEach((vc, i) => {
            if (!vc) return;
            ['body', 'trim', 'tertiary'].forEach((k, t) => {
                if (isNumber(vc[k])) run('ridesetappearance', { type: 3 + t, value: vc[k], index: i }, 'vehicle colour');
            });
        });
        if (isNumber(c.vehicleColourSettings)) {
            await run('ridesetappearance', { type: 6, value: c.vehicleColourSettings, index: 0 }, 'vehicle colour scheme');
        }
    }

    /** Will this candidate have room for an entrance and an exit (the design's own, or beside the station)? */
    function portalsPossible(tc, layout, cand, z) {
        // Tiles the layout's own track will cover once built.
        const own = new Set();
        for (const p of cand.walked.pieces) {
            for (const b of p.blocks) own.add(tileKey(cand.ox + Math.floor(b.x / TILE_SIZE), cand.oy + Math.floor(b.y / TILE_SIZE)));
        }
        const ents = (layout.entrances || []).map(e => {
            const r = rotate(e.x, e.y, cand.direction);
            const x = cand.ox + Math.floor(r.x / TILE_SIZE);
            const y = cand.oy + Math.floor(r.y / TILE_SIZE);
            const dir = (cand.direction + e.direction) & 3;
            const ez = e.z === null || e.z === undefined ? z : e.z * 8 + z;
            const fx = x + DIR_DX[dir ^ 2];
            const fy = y + DIR_DY[dir ^ 2];
            return { ok: !own.has(tileKey(fx, fy)) && portalSpotOk(tc, x, y, ez, fx, fy), isExit: !!e.isExit };
        });
        if (ents.some(e => e.ok && !e.isExit) && ents.some(e => e.ok && e.isExit)) return true;
        const stations = portalPieces(cand.walked);
        if (stations.length === 0) return ents.length === 0 || ents.every(e => e.ok);
        const stationZ = z + Math.min(...stations.map(p => p.z));
        const spots = stationAttachmentPoints(cand.walked, cand.ox, cand.oy)
            .filter(a => !own.has(tileKey(a.x, a.y)) && !own.has(tileKey(a.front.x, a.front.y))
                && portalSpotOk(tc, a.x, a.y, stationZ, a.front.x, a.front.y));
        return spots.length >= 2;
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

    async function placeMaze(tc, layout, rideId, ox, oy, z, direction, flags) {
        const rol16 = (v, n) => {
            n &= 15;
            return ((v << n) | (v >>> (16 - n))) & 0xFFFF;
        };
        let cost = 0;
        for (const m of layout.mazeElements) {
            const r = rotate(m.x * TILE_SIZE, m.y * TILE_SIZE, direction);
            const res = await executeAction('mazeplacetrack', {
                x: ox * TILE_SIZE + r.x, y: oy * TILE_SIZE + r.y, z: z, ride: rideId,
                mazeEntry: rol16(m.entry, direction * 4), flags: flags,
            });
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
    async function buildLayout(layout, params) {
        ensureCanBuild(params);
        const isMaze = Array.isArray(layout.mazeElements) && layout.mazeElements.length > 0;
        const elements = layout.trackElements || [];
        if (!isMaze && elements.length === 0) fail('The layout has no track pieces.');
        if (elements.length > 3000) fail('The layout has too many pieces.');
        const { option, substituted } = resolveLayoutRide(layout, params);
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
            for (const cand of candidates.slice(0, 16)) {
                const z0 = isMaze ? null : layoutBaseZ(tc, cand.walked, cand.ox, cand.oy);
                if (!isMaze && z0 === null) continue;
                const startZ = isNumber(params.z) ? Math.floor(params.z) : z0;
                for (let attempt = 0; attempt < (isNumber(params.z) ? 1 : 7) && !chosen; attempt++) {
                    const z = isMaze ? (isNumber(params.z) ? params.z : surfaceTop(tc.get(cand.ox, cand.oy))) : startZ + attempt * 8;
                    let ok = true;
                    let cost = 0;
                    if (!isMaze) {
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
                    if (ok && !isMaze && !portalsPossible(tc, layout, cand, z)) {
                        ok = false;
                        reasons.push('no usable spot for the entrance and exit');
                    }
                    if (ok) chosen = Object.assign({ z: z, estimatedCost: cost }, cand);
                }
                if (chosen) break;
            }
            if (!chosen) {
                fail('The game rejected every candidate placement for this layout.', {
                    reasons: Array.from(new Set(reasons)).slice(0, 6),
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

            // Build the track inside one game tick so it executes atomically and keeps isFromTrackDesign.
            let spent = 0;
            if (isMaze) {
                spent += await placeMaze(tc, layout, rideId, chosen.ox, chosen.oy, chosen.z, chosen.direction, flags);
            } else {
                const results = await inNextTick(() => chosen.walked.pieces.map(p =>
                    executeActionNow('trackplace', trackPlaceArgs(rideId, option.rideType, p, chosen.ox, chosen.oy, chosen.z, flags))));
                let queued = results.some(r => r === null);
                if (queued) {
                    // Paused: the actions were queued; wait for their results.
                    const awaited = await Promise.all(chosen.walked.pieces.map(p =>
                        executeAction('trackplace', trackPlaceArgs(rideId, option.rideType, p, chosen.ox, chosen.oy, chosen.z, flags))));
                    results.splice(0, results.length, ...awaited);
                }
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
                    .filter(p => portalSpotOk(tcNow, p.x, p.y, p.z === null ? chosen.z : p.z, p.front.x, p.front.y));
            }
            if (!portals.some(p => !p.isExit) || !portals.some(p => p.isExit)) {
                const keep = portals;
                const entrances = await getParkEntrances();
                const goalTiles = entrances.map(e => [e.x, e.y]);
                for (const key of computeParkNetwork(new TileCache(), entrances)) {
                    const [nx, ny] = key.split(',');
                    goalTiles.push([+nx, +ny]);
                }
                const field = distanceField(tc, goalTiles);
                const stationZ = chosen.z + Math.min(...portalPieces(chosen.walked).map(p => p.z));
                const taken = new Set(keep.map(p => tileKey(p.x, p.y)));
                const spots = stationAttachmentPoints(chosen.walked, chosen.ox, chosen.oy)
                    .filter(a => !taken.has(tileKey(a.x, a.y)) && portalSpotOk(tcNow, a.x, a.y, stationZ, a.front.x, a.front.y));
                const ranked = rankAttachments(tcNow, spots, field, stationZ);
                const pair = chooseEntranceAndExit(ranked);
                if (!pair) fail('No room beside the station for an entrance and exit.');
                portals = keep.slice();
                if (!keep.some(p => !p.isExit)) {
                    portals.push({ x: pair.entrance.x, y: pair.entrance.y, direction: pair.entrance.direction, station: 0, isExit: false });
                }
                if (!keep.some(p => p.isExit)) {
                    const exit = keep.some(p => !p.isExit) ? pair.entrance : pair.exit;
                    portals.push({ x: exit.x, y: exit.y, direction: exit.direction, station: 0, isExit: true });
                }
                warnings.push('placed ' + (keep.length ? 'some' : 'the') + ' entrance/exit beside the station instead of where the design had them');
            }
            for (const p of portals) {
                const res = await executeAction('rideentranceexitplace', {
                    x: p.x * TILE_SIZE, y: p.y * TILE_SIZE, direction: p.direction, ride: rideId, station: p.station,
                    isExit: p.isExit, flags: flags,
                });
                if (res.error !== 0) warnings.push((p.isExit ? 'exit' : 'entrance') + ' at ' + p.x + ',' + p.y + ': ' + describeResult(res));
                else spent += res.cost || 0;
            }

            await applyLayoutSettings(rideId, layout, option, flags, warnings);
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
                const pathParams = { rideId: rideId, allowWhilePaused: params.allowWhilePaused };
                summary.paths = {};
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
            await applyRideSettings(rideId, params, flags, summary);
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
                        station: el.station,
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
            const points = rankAttachments(tc, attachmentPoints(info.startPiece, fp, p.origin.x, p.origin.y, p.direction), field, p.z);
            if (isStall) {
                if (points.length > 0) plans.push(Object.assign({ pathFrom: points[0] }, p));
            } else {
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
            if (plan.pathFrom) out.pathConnection = plan.pathFrom.front;
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
                    const r = await methods.build_path_route(Object.assign({ from: built.pathFrom.front }, pathParams));
                    summary.paths.access = r.alreadyConnected ? 'already connected' : { built: r.built, cost: r.costFormatted };
                    spent += r.cost || 0;
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

    /** Optional price and status changes after building. */
    async function applyRideSettings(rideId, params, flags, summary) {
        if (isNumber(params.price)) {
            const r = await executeAction('ridesetprice', { ride: rideId, price: Math.round(params.price), isPrimaryPrice: true, flags: flags });
            summary.price = r.error === 0 ? formatMoney(Math.round(params.price)) : 'failed: ' + describeResult(r);
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

    /** Offset from a piece's start to the next piece's start: forward/right tiles, up in z, and the turn. */
    function pieceMove(seg) {
        const turn = (seg.endDirection - seg.beginDirection) & 3;
        const diagonal = (seg.endDirection & 4) !== 0;
        // For heading 0 (x-1) forward is -x and right is +y.
        const nx = seg.endX / TILE_SIZE + (diagonal ? 0 : DIR_DX[turn]);
        const ny = seg.endY / TILE_SIZE + (diagonal ? 0 : DIR_DY[turn]);
        return {
            forward: -nx,
            right: ny,
            up: seg.endZ - seg.beginZ,
            turn: turn === 1 ? 'right' : turn === 3 ? 'left' : turn === 2 ? 'reverse' : 'none',
            endsDiagonal: diagonal,
        };
    }

    /** Turns agent-supplied pieces (names, ids or objects) into layout track elements. */
    function normaliseLayoutPieces(pieces) {
        if (!Array.isArray(pieces) || pieces.length === 0) fail('"pieces" must be a non-empty array of track pieces.');
        return pieces.map((p, i) => {
            const spec = typeof p === 'object' && p !== null ? p : { type: p };
            let type = spec.type;
            if (typeof type === 'string') {
                const idx = TRACK_TYPE_NAMES.indexOf(type);
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
    function checkLayout(elements, allowed) {
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
        if (params.pieces) {
            // Custom layouts must form a proper circuit before anything is placed.
            const option = resolveRideOption(params, ['tracked', 'tower']);
            const report = checkLayout(layout.trackElements, params.allowAnyPiece ? null : allowedPieceTypes(option.rideType));
            const kind = rideTypeInfo(option.rideType).kind;
            if (kind === 'tracked' && report.stationPieces === 0) report.problems.push('the layout has no station pieces');
            if (kind === 'tracked' && !report.closesCircuit && !params.allowOpenCircuit) {
                report.problems.push('the layout does not return to its start (ends at ' + JSON.stringify(report.end) + ')');
            }
            if (report.problems.length > 0) fail('The layout is not buildable as given.', report);
        }
        return buildLayout(layout, params);
    };

    methods.check_track_layout = params => {
        const elements = normaliseLayoutPieces(params.pieces);
        let allowed = null;
        if (params.ride !== undefined || params.object !== undefined || isNumber(params.rideType)) {
            allowed = allowedPieceTypes(resolveRideOption(params, ['tracked', 'tower']).rideType);
        }
        return checkLayout(elements, allowed);
    };

    methods.list_track_pieces = params => {
        const option = resolveRideOption(params, ['tracked', 'tower']);
        const allowed = allowedPieceTypes(option.rideType);
        const pieces = [];
        for (const t of allowed) {
            const seg = trackSegment(t);
            if (!seg) continue;
            if (params.group && TRACK_GROUPS[seg.trackGroup] !== params.group) continue;
            const turn = (seg.endDirection - seg.beginDirection) & 3;
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
