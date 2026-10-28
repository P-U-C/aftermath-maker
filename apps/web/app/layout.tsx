import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const monaSans = localFont({
  src: [
    {
      path: "../../../node_modules/@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2",
      weight: "200 900",
      style: "normal",
    },
    {
      path: "../../../node_modules/@fontsource-variable/mona-sans/files/mona-sans-latin-ext-standard-normal.woff2",
      weight: "200 900",
      style: "normal",
    },
  ],
  declarations: [{ prop: "font-stretch", value: "75% 125%" }],
  variable: "--font-mona",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Maker",
  description:
    "A wallet-gated market-making desk for controlled quoting across venues.",
  applicationName: "Maker",
  icons: {
    icon: "/icon-stopped.svg",
    apple: "/apple-touch-icon.png",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={monaSans.variable}>
      <body>{children}</body>
    </html>
  );
}
