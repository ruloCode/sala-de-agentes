import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/state/ThemeProvider";
import { THEME_INIT_SCRIPT } from "@/state/theme-init";

// La var se llama --font-inter (no --font-sans) porque el @theme de
// globals.css define esta última referenciándola: con el mismo nombre habría
// una referencia circular.
const sans = Inter({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Sala de agentes",
  description: "Agentes con voz propia que conversan contigo y responden con datos reales",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: el script de tema escribe data-theme antes de
    // que React hidrate (evita el destello claro/oscuro al cargar).
    <html lang="es" className={sans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
