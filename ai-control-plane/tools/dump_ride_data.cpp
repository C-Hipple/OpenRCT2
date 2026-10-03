/*****************************************************************************
 * Dumps the ride type and track data the AI Control Plane plugin needs but the
 * plugin API does not expose (ride type descriptors, track sequence flags).
 * Build against libopenrct2 and run gen_ride_data.py; see README.md.
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#include <openrct2/ride/Ride.h>
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
        std::printf(
            "%s{\"id\":%d,\"name\":\"%s\",\"category\":%d,\"start\":%d,\"flags\":[%s],\"groups\":[%s],\"extra\":[%s],"
            "\"maxHeight\":%d,\"liftMin\":%d,\"liftMax\":%d,\"special\":%d}\n",
            t ? "," : "", t, std::string(rtd.Name).c_str(), static_cast<int>(rtd.Category),
            static_cast<int>(rtd.StartTrackPiece), flags.c_str(), groupList(rtd.TrackPaintFunctions.Regular.enabledTrackGroups).c_str(),
            groupList(rtd.TrackPaintFunctions.Regular.extraTrackGroups).c_str(), rtd.Heights.MaxHeight,
            rtd.LiftData.minimum_speed, rtd.LiftData.maximum_speed, static_cast<int>(rtd.specialType));
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
    std::printf("}}\n");
    return 0;
}
