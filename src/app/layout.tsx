import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dinodia V2',
  description: 'Native Dinodia V2 foundation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased">{children}</body>
    </html>
  );
}
