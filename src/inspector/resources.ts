// The distribution-network search item behind a `net` ref (its label, trace chain, DTR attributes),
// resolved in the search worker. A search pick primes it, so picking a result is instant; a map tap
// or a deep link looks it up (loading the network tier once).
import type { NetItem } from "../data/network-search.ts";
import { defineResource } from "../data/resources.ts";
import { lookupNetBelow, lookupNetRef } from "../data/search-client.ts";
import { netRef } from "./refs.ts";

const primed = new Map<string, NetItem>();

/** Remember a search result so its Inspector opens without a worker round-trip. */
export function primeNetItem(item: NetItem): string {
  const ref = netRef(item);
  primed.set(ref, item);
  return ref;
}

export const netItemRes = defineResource<NetItem | null>("net-item", {
  load: async (ref) => primed.get(ref) ?? lookupNetRef(ref),
});

/** The 11 kV feeders under a 33/11 kV substation (search worker) — the Inspector's downstream trace. */
export const netBelowRes = defineResource<NetItem[]>("net-below", { load: (ref) => lookupNetBelow(ref) });
