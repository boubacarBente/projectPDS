import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/app-shell';
import { ToastContainer } from 'react-toastify';
import { SettingsProvider } from './parametres/page';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from '@/components/auth-provider';
import { ScrollRestoration } from '@/components/scroll-restoration';
import './globals.css';

export const metadata: Metadata = {
  title: 'Planète Déco — Gestion',
  description:
    'Système de gestion commerciale, ventes et stocks — Planète Déco Sarlu, filiale Meubles.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Jusqu'à 2560 px : contrat de la règle des 5 largeurs (§5.5).
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full">
        <AuthProvider>
          <SettingsProvider>
            <ThemeProvider>
              <ScrollRestoration />
              <AppShell>{children}</AppShell>
              <ToastContainer
                position="top-right"
                autoClose={4000}
                hideProgressBar={false}
                newestOnTop
                closeOnClick
                rtl={false}
                pauseOnFocusLoss
                draggable
                pauseOnHover
                theme="colored"
              />
            </ThemeProvider>
          </SettingsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
