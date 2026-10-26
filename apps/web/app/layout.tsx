import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Maker | Aftermath on Sui",
  description: "Wallet-gated autonomous market making for Aftermath on Sui",
  applicationName: "Maker",
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
