import type { VenueDescriptor } from "../lib/venues";

type VenueChipProps = {
  venue: VenueDescriptor;
  compact?: boolean;
};

export function VenueChip({ venue, compact = false }: VenueChipProps) {
  return (
    <span
      className={compact ? "venue-chip venue-chip-compact" : "venue-chip"}
      title={`${venue.name} on ${venue.network}`}
    >
      <span className="venue-glyph" aria-hidden="true">
        {venue.glyph}
      </span>
      {!compact && venue.name}
    </span>
  );
}
