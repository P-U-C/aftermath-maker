import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Maker | Aftermath on Sui",
  description: "Private market-making control plane for Aftermath on Sui",
  applicationName: "Maker",
  robots: { index: false, follow: false },
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
