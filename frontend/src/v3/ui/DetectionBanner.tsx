/**
 * Shown only while a preview override of rules detection is in force (localhost or an opted-in build; never on the
 * public site, see src/v3/detect.ts). Renders nothing otherwise, so the live pages are unchanged.
 */
import { useDetection } from '../detect';

export default function DetectionBanner() {
    const d = useDetection();
    if (!d.override) return null;
    return (
        <div role="status" className="container mx-auto px-4 pt-3">
            <div className="p-2 rounded-lg border border-amber-500/60 bg-amber-500/10 text-amber-200 text-xs">
                Preview override of rules detection: program rules {String(d.rules)}, rewards rules {String(d.rewards)} (forced
                {d.override.rules ? ` rules=${d.override.rules}` : ''}{d.override.rewards ? ` rewards=${d.override.rewards}` : ''}). This only works on a local preview.
                Add <code>?mf_detect=clear</code> to the address to go back to what X1 and the epoch files say.
            </div>
        </div>
    );
}
