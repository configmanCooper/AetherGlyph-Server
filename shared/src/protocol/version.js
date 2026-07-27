// version.js — protocol / balance versioning. A mismatch must be detectable so
// clients and the (Phase 2) authoritative server never silently disagree.

import { SPELLS_SOURCE_CHECKSUM } from '../balance/spellData.generated.js';

export const PROTOCOL_VERSION = 3;
export const BALANCE_VERSION = 29;
export const APP_PHASE = 5;
export const APP_VERSION = '1.11.0';

// The spell-data checksum ties the running build to a specific roster snapshot.
export const ROSTER_CHECKSUM = SPELLS_SOURCE_CHECKSUM;

export function versionTag() {
  return `p${PROTOCOL_VERSION}.b${BALANCE_VERSION}.r${ROSTER_CHECKSUM}`;
}

export function isCompatible(remote) {
  return remote
    && remote.protocol === PROTOCOL_VERSION
    && remote.balance === BALANCE_VERSION
    && remote.roster === ROSTER_CHECKSUM;
}
