import type { Voltage } from "../data/types.ts";
import { VOLTAGE_COLOR } from "../theme/palette.ts";

export function VoltageBadge({ voltage, small }: { voltage: Voltage; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold text-white ${
        small ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
      }`}
      style={{ backgroundColor: VOLTAGE_COLOR[voltage] }}
    >
      {voltage} kV
    </span>
  );
}

export function VoltageDot({ voltage, size = 10 }: { voltage: Voltage; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ backgroundColor: VOLTAGE_COLOR[voltage], width: size, height: size }}
    />
  );
}
