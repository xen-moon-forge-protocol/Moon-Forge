/**
 * Official links, the "never" list, the verification facts and the privacy notice: everything comes from
 * public/links.json, the single source for every surface (site, kit card, llms.txt, README). No component
 * should hard-code a project URL; render these instead (closure-matrix T9-30, T9-29, X-064).
 */
import linksJson from '../../public/links.json';

export interface OfficialLink { id: string; label: string; url: string; handle?: string; note?: string }
export interface PendingLink { id: string; label: string; url: null; note: string }
export interface ThirdParty { name: string; hosts: string[]; sees: string; when: string }
export interface VerifyFacts {
  note: string; site: string; github: string; programId: string; programExplorer: string; collection: string;
  portal: string; portalChains: string[]; release: string | null; releaseUrl?: string;
}
export interface LinksFile {
  version: number;
  updated: string;
  site: string;
  official: OfficialLink[];
  /** Where security.txt is served (a project page cannot use the RFC 9116 root location). */
  securityTxt?: { url: string; note: string };
  pending: PendingLink[];
  notOfficial: string;
  never: string[];
  verify: VerifyFacts;
  privacy: { sentence: string; thirdParties: ThirdParty[] };
  signature: null | { signer: string; sig: string; signedAt: string };
  signatureNote?: string;
}

/** The copy bundled with this build (identical to the served /links.json of the same deploy). */
export const LINKS: LinksFile = linksJson as LinksFile;

export const officialLink = (id: string): OfficialLink | null => LINKS.official.find((l) => l.id === id) ?? null;
export const officialUrl = (id: string): string => officialLink(id)?.url ?? '';
/** Links shown as the official places (everything but the security/mailbox contacts). */
export const PUBLIC_PLACES = LINKS.official.filter((l) => l.id !== 'security' && l.id !== 'mailbox');
/** The mailbox as text (never an auto-mail link in the UI). */
export const MAILBOX = officialUrl('mailbox').replace(/^mailto:/, '');

/** URL of the served file, for the "verify this list" link and for other surfaces. */
export const LINKS_URL = `${import.meta.env.BASE_URL}links.json`;

/** The served copy (what the kit and the docs read). Falls back to the bundled copy when offline. */
export async function fetchLinks(): Promise<LinksFile> {
  try {
    const r = await fetch(LINKS_URL, { cache: 'no-store' });
    if (!r.ok) return LINKS;
    const j = (await r.json()) as LinksFile;
    return typeof j.version === 'number' && Array.isArray(j.official) ? j : LINKS;
  } catch {
    return LINKS;
  }
}
