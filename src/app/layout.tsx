import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DAVIS | Data Analysis & Virtual Intelligence System",
  description:
    "AI-powered enterprise data intelligence platform by SPOR Systems. Connect databases, ingest knowledge bases, and get instant insights through natural language.",
  keywords: [
    "AI",
    "data analysis",
    "enterprise",
    "chatbot",
    "database",
    "knowledge base",
    "SPOR Systems",
  ],
  authors: [{ name: "SPOR Systems Inc." }],
};

import { Providers } from "@/components/Providers";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
