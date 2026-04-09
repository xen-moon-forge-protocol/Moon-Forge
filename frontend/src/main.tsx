import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { WalletProvider } from './context/WalletContext';
import { ReferralProvider } from './context/ReferralContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
            <ReferralProvider>
                <WalletProvider>
                    <App />
                </WalletProvider>
            </ReferralProvider>
        </BrowserRouter>
    </React.StrictMode>
);
