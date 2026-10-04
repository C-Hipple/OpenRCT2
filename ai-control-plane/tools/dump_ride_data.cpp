/*****************************************************************************
 * Dumps the ride type and track data the AI Control Plane plugin needs but the
 * plugin API does not expose (ride type descriptors, track sequence flags, track block clearances).
 * Build against libopenrct2 and run gen_ride_data.py; see README.md.
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#include <openrct2/ride/Ride.h>
#include <openrct2/ride/Vehicle.h>
#include <openrct2/ride/RideData.h>
#include <openrct2/ride/TrackData.h>
#include <openrct2/ride/ted/TrackElementDescriptor.h>
#include <openrct2/ride/ted/TrackElemType.h>
#include <openrct2/ride/ted/TrackGroup.h>

#include <cstdio>
#include <string>

using namespace OpenRCT2;
using namespace OpenRCT2::TrackMetadata;

static std::string groupList(const RideTrackGroups& groups)
{
    std::string s;
    for (int i = 0; i < static_cast<int>(TrackGroup::count); i++)
    {
        if (groups.get(i))
            s += (s.empty() ? "" : ",") + std::to_string(i);
    }
    return s;
}

int main()
{
    std::printf("{\"trackGroupCount\":%d,\"trackTypeCount\":%d,\"rideTypes\":[\n", static_cast<int>(TrackGroup::count),
                static_cast<int>(TrackElemType::count));
    for (int t = 0; t < RIDE_TYPE_COUNT; t++)
    {
        const auto& rtd = GetRideTypeDescriptor(static_cast<ride_type_t>(t));
        std::string flags;
        for (int f = 0; f < 64; f++)
        {
            if (rtd.flags.has(static_cast<RtdFlag>(f)))
                flags += (flags.empty() ? "" : ",") + std::to_string(f);
        }
        // Rating requirements (a ride that misses one has its ratings divided): [modifier type, threshold].
        std::string requirements;
        for (const auto& m : rtd.RatingsData.Modifiers)
        {
            if (m.type >= RatingsModifierType::requirementLength && m.type < RatingsModifierType::penaltyLateralGs)
                requirements += std::string(requirements.empty() ? "" : ",") + "[" + std::to_string(static_cast<int>(m.type))
                    + "," + std::to_string(m.threshold) + "]";
        }
        std::printf(
            "%s{\"id\":%d,\"name\":\"%s\",\"category\":%d,\"start\":%d,\"flags\":[%s],\"groups\":[%s],\"extra\":[%s],"
            "\"maxHeight\":%d,\"liftMin\":%d,\"liftMax\":%d,\"special\":%d,\"clearance\":%d,\"requirements\":[%s],"
            "\"relaxIfInversions\":%s,\"maxMass\":%d}\n",
            t ? "," : "", t, std::string(rtd.Name).c_str(), static_cast<int>(rtd.Category),
            static_cast<int>(rtd.StartTrackPiece), flags.c_str(), groupList(rtd.TrackPaintFunctions.Regular.enabledTrackGroups).c_str(),
            groupList(rtd.TrackPaintFunctions.Regular.extraTrackGroups).c_str(), rtd.Heights.MaxHeight,
            rtd.LiftData.minimum_speed, rtd.LiftData.maximum_speed, static_cast<int>(rtd.specialType),
            rtd.Heights.ClearanceHeight, requirements.c_str(), rtd.RatingsData.RelaxRequirementsIfInversions ? "true" : "false",
            rtd.MaxMass);
    }
    std::printf("],\"sequenceFlags\":{");
    bool first = true;
    for (int t = 0; t < static_cast<int>(TrackElemType::count); t++)
    {
        const auto& ted = GetTrackElementDescriptor(static_cast<TrackElemType>(t));
        bool any = false;
        for (int s = 0; s < ted.sequenceData.numSequences; s++)
        {
            // Entrance connection sides (bits 0-3) or "connects to path" (bit 5).
            if (ted.sequenceData.sequences[s].flags.holder & 0x2F)
                any = true;
        }
        if (!any)
            continue;
        std::printf("%s\"%d\":[", first ? "" : ",", t);
        first = false;
        for (int s = 0; s < ted.sequenceData.numSequences; s++)
            std::printf("%s%d", s ? "," : "", ted.sequenceData.sequences[s].flags.holder);
        std::printf("]");
    }
    // Per block clearance above the block's base z (the ride's own clearance is added on top); +256 marks
    // vertical blocks, whose ride clearance is capped at 24 (TrackPlaceAction).
    std::printf("},\"blockClearance\":[");
    for (int t = 0; t < static_cast<int>(TrackElemType::count); t++)
    {
        const auto& ted = GetTrackElementDescriptor(static_cast<TrackElemType>(t));
        std::printf("%s[", t ? "," : "");
        for (int s = 0; s < ted.sequenceData.numSequences; s++)
        {
            const auto& c = ted.sequenceData.sequences[s].clearance;
            std::printf("%s%d", s ? "," : "", c.clearanceZ + (c.flags.has(ClearanceFlag::isVertical) ? 256 : 0));
        }
        std::printf("]");
    }
    // Per track type: the smallest |vertical factor| among negative values (sharpest crest: negative G grows
    // with speed / factor) and the smallest |lateral factor| (sharpest turn), over the piece's length
    // (Vehicle::GetGForces). 0 = none. Used to keep cars without upstop wheels from derailing (upstopCheck).
    std::printf("],\"gForceFactors\":[");
    for (int t = 0; t < static_cast<int>(TrackElemType::count); t++)
    {
        const auto& ted = GetTrackElementDescriptor(static_cast<TrackElemType>(t));
        const auto length = VehicleGetMoveInfoSize(VehicleTrackSubposition::standard, static_cast<TrackElemType>(t), 0);
        int32_t crest = 0;
        int32_t lateral = 0;
        for (int32_t p = 0; p < std::max<int32_t>(length, 1); p++)
        {
            const int32_t v = ted.verticalFactor(static_cast<int16_t>(p));
            const int32_t l = ted.lateralFactor(static_cast<int16_t>(p));
            if (v < 0 && (crest == 0 || -v < crest))
                crest = -v;
            if (l != 0 && (lateral == 0 || std::abs(l) < lateral))
                lateral = std::abs(l);
        }
        std::printf("%s[%d,%d]", t ? "," : "", crest, lateral);
    }
    std::printf("]}\n");
    return 0;
}
