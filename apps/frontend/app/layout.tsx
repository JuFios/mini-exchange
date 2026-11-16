import './globals.css';

// CSP nonce окремий для кожної відповіді, тому HTML не можна зберігати як статичний.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Mini Exchange',
  description: 'Торговий термінал Mini Exchange',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
