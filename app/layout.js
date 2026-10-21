import './globals.css';
import { Shippori_Mincho, IBM_Plex_Sans } from 'next/font/google';

const serif = Shippori_Mincho({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-serif', display: 'swap' });
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-sans', display: 'swap' });

export const metadata = { title: 'Clan Ranking Board', description: 'Ninja Zenshin clan ranking and war results tracker' };
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function Layout({ children }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
