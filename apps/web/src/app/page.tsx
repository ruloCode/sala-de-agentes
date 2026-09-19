import Link from "next/link";

/**
 * Portada: las dos pantallas que sirve este repo. No es un dashboard — cada
 * una se abre sola, a pantalla completa, y así es como se usan.
 */
const PANTALLAS = [
  {
    href: "/sala",
    titulo: "Sala de agentes",
    que: "Varios agentes con voz propia en una escena 3D. Tu cuerpo entra por la webcam y levantar la mano elige con quién hablas.",
    como: "Necesita cámara. Se conecta sola cuando te ve.",
  },
  {
    href: "/estacion",
    titulo: "Tótem de estación",
    que: "Pantalla vertical para un andén: preguntas cómo llegar y responde con la ruta real del sistema de transporte, sus líneas y transbordos.",
    como: "Pensada para 1080×1920. Esc la deja lista para el siguiente viajero.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[760px] flex-col justify-center gap-10 px-6 py-16">
      <header>
        <h1 className="text-2xl font-medium">Sala de agentes</h1>
        <p className="mt-2 text-sm text-text-dim">
          Dos pantallas sobre el mismo motor: un agente multi-voz que conversa y responde con datos que existen.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {PANTALLAS.map((p) => (
          <Link
            key={p.href}
            href={p.href}
            className="rounded-lg border border-line bg-panel p-5 transition-colors hover:border-accent"
          >
            <p className="text-base font-medium">{p.titulo}</p>
            <p className="mt-1.5 text-sm text-text-dim">{p.que}</p>
            <p className="mt-2 text-xs text-text-faint">{p.como}</p>
          </Link>
        ))}
      </div>

      <p className="text-xs text-text-faint">
        Los personajes salen de <code className="font-mono">sala.json</code> y los datos del transporte del GTFS que
        pongas en la carpeta de configuración. Sin esos archivos las pantallas lo dicen, en vez de inventar.
      </p>
    </main>
  );
}
