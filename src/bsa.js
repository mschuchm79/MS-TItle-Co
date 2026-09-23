// BS&A Online (bsaonline.com) integration: municipal property tax, utility
// billing, special assessment, assessing, and building records.
// BS&A has no public API and gates searches behind a security verification,
// so the app deep-links pre-filled searches and staff record what they find.
import { readFileSync } from 'node:fs';

export const BSA_BASE = 'https://bsaonline.com';

export const BSA_MUNICIPALITIES = JSON.parse(
  readFileSync(new URL('../config/bsa-municipalities.json', import.meta.url), 'utf8'),
).municipalities;

export function municipalityName(uid) {
  return BSA_MUNICIPALITIES.find((m) => m.uid === Number(uid))?.name ?? null;
}

// Municipal items checked on every file; each must be checked before the
// file can leave "Clearing Title".
export const MUNICIPAL_CHECKS = [
  { category: 'property_tax', label: 'Property taxes (current & delinquent)' },
  { category: 'utility', label: 'Water / sewer utility balance' },
  { category: 'special_assessment', label: 'Special assessments' },
  { category: 'assessing', label: 'Assessing record (owner of record, legal, principal residence exemption)' },
  { category: 'building', label: 'Open building permits / code violations' },
];

// not_checked blocks closing; balance_due is carried to the settlement as a seller charge.
export const MUNICIPAL_STATUSES = ['not_checked', 'clear', 'balance_due', 'paid'];

function searchUrl(uid, category, text) {
  const params = new URLSearchParams({
    SearchFocus: 'All Records',
    SearchCategory: category,
    SearchText: text,
    uid: String(uid),
  });
  return `${BSA_BASE}/SiteSearch/SiteSearchResults?${params}`;
}

// Links for a file. Returns null when no BS&A municipality is set.
export function bsaLinks({ bsa_uid, property_address, parcel_number }, ownerName) {
  if (!bsa_uid) return null;
  const links = [{ key: 'home', label: 'Municipality portal', url: `${BSA_BASE}/?uid=${bsa_uid}` }];
  if (property_address) {
    links.push({ key: 'address', label: `Search address: ${property_address}`, url: searchUrl(bsa_uid, 'Address', property_address) });
  }
  if (parcel_number) {
    links.push({ key: 'parcel', label: `Search parcel: ${parcel_number}`, url: searchUrl(bsa_uid, 'Parcel Number', parcel_number) });
  }
  if (ownerName) {
    links.push({ key: 'owner', label: `Search owner: ${ownerName}`, url: searchUrl(bsa_uid, 'Name', ownerName) });
  }
  return { uid: bsa_uid, municipality: municipalityName(bsa_uid), links };
}
