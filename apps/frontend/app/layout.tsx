import './globals.css';

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
