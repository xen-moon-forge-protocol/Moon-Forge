/**
 * Error codes the live IDL does not know (6064 … 6100, added by the final upgrade). src/v3/program.ts registers the new
 * IDL's error list when it loads (only under rules 3), and lib/protocol.ts errorMessage() consults it for a custom
 * program error code above the live range. Before the upgrade nothing is registered and no such code can occur, so the
 * live behaviour is unchanged.
 */
export const LIVE_MAX_ERROR_CODE = 6063;

/**
 * Codes whose text the site states itself, whether or not the new IDL was loaded on this page (an old path, such as a
 * donation to the Burn Lottery vault sent by an old page or a script, reaches the upgraded program without it).
 * 6100 LotteryRetired: the IDL says "tickets"; since r9 the program also refuses donations to the lottery vault with it.
 */
export const STATIC_V3_ERRORS: Readonly<Record<number, string>> = {
    6100: 'The Burn Lottery is retired since the final upgrade: it takes no new tickets and no donations; nothing was moved (LotteryRetired, 6100)',
};

let table: Map<number, string> | null = null;

export function registerV3Errors(errors: readonly { code: number; name: string; msg?: string }[]) {
    table = new Map(errors.filter((e) => e.code > LIVE_MAX_ERROR_CODE).map((e) => [e.code, `${e.msg ?? e.name} (${e.name})`]));
}

/** The custom program error code in an RPC / Anchor error (hex "custom program error: 0x17b2" or a decimal "Error Number: 6066"). */
export function customErrorCode(e: any): number | null {
    const n = e?.error?.errorCode?.number;
    if (Number.isInteger(n)) return n;
    const text = [e?.message, ...(Array.isArray(e?.logs) ? e.logs : []), ...(Array.isArray(e?.transactionLogs) ? e.transactionLogs : [])].filter(Boolean).join('\n');
    const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (hex) return parseInt(hex[1], 16);
    const dec = text.match(/Error Number: (\d{4})/);
    return dec ? Number(dec[1]) : null;
}

/** Text of a code the site states itself (STATIC_V3_ERRORS), or null. */
export function staticErrorFor(e: any): string | null {
    const code = customErrorCode(e);
    return code !== null ? STATIC_V3_ERRORS[code] ?? null : null;
}

/** Text of a code added by the upgrade, or null (not registered, or a live code). */
export function v3ErrorFor(e: any): string | null {
    const code = customErrorCode(e);
    if (code !== null && STATIC_V3_ERRORS[code]) return STATIC_V3_ERRORS[code];
    if (!table) return null;
    return code !== null && code > LIVE_MAX_ERROR_CODE ? table.get(code) ?? null : null;
}
