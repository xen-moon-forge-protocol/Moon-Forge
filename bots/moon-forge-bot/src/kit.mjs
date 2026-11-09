// The one place that points at the Moon Forge agent kit. Inside the Moon Forge repository the kit sits two folders up;
// in a fork that keeps only this bot, copy agents/kit next to it and change the paths below (nothing else imports the
// kit directly). The kit is pinned by the repository commit you reviewed: never auto-update a funded bot.
export {
  quoteBurn, planBurns, burnXen, feedProblems, fetchWeekFeed, BurnRefused, PORTALS as KIT_PORTALS, PORTAL as KIT_PORTAL,
  NOTICES as BURN_NOTICES, readLastPublishTs, checkX1Destination, encodeBalanceOf, encodeAllowance, SELECTORS,
} from '../../../agents/kit/burn.mjs';
export { EpochSource, SITE_URL } from '../../../agents/kit/epochs.mjs';
export { V3, minimumListPrice } from '../../../agents/kit/rules-v3.mjs';
export { redactUrls } from '../../../agents/kit/errors.mjs';

/** The full kit client (anchor, web3.js) is loaded only when the bot needs X1 calls: claims, games, artifacts, live burns. */
export const loadClient = () => import('../../../agents/kit/moonforge.mjs');

export const WEEK_FEED_URL = 'https://xen-moon-forge-protocol.github.io/Moon-Forge/feed/week-so-far.json';
