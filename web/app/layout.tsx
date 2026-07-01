import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Cowrie — private stablecoin wallet",
  description: "Hold USDC privately on Stellar. Spend at merchants with ZK proofs.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
