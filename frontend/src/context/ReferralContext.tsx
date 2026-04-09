/**
 * Moon Forge - Referral Context
 * 
 * Handles referral tracking from URL parameters.
 * Stores referrer address for future contract integration.
 */

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface ReferralContextType {
    referrer: string | null;
    setReferrer: (address: string) => void;
    getReferralLink: (address: string) => string;
}

const ReferralContext = createContext<ReferralContextType | null>(null);

export const useReferral = () => {
    const ctx = useContext(ReferralContext);
    if (!ctx) throw new Error('useReferral must be inside ReferralProvider');
    return ctx;
};

export const ReferralProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [referrer, setReferrerState] = useState<string | null>(null);

    // Check URL for referral parameter on mount
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const refParam = params.get('ref');

        if (refParam && refParam.startsWith('0x') && refParam.length === 42) {
            setReferrerState(refParam);
            localStorage.setItem('moonforge_referrer', refParam);
        } else {
            // Check localStorage for existing referrer
            const saved = localStorage.getItem('moonforge_referrer');
            if (saved) setReferrerState(saved);
        }
    }, []);

    const setReferrer = (address: string) => {
        setReferrerState(address);
        localStorage.setItem('moonforge_referrer', address);
    };

    const getReferralLink = (address: string): string => {
        const base = window.location.origin + window.location.pathname;
        return `${base}?ref=${address}`;
    };

    return (
        <ReferralContext.Provider value={{ referrer, setReferrer, getReferralLink }}>
            {children}
        </ReferralContext.Provider>
    );
};
