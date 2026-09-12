// src/components/FondoAnimado.jsx
//
// Fondo inmersivo: gradiente profundo + orbes de color + estrellas que
// titilan suavemente (Canvas 2D). Ligero: rAF pausado sin visibilidad.
//
// `matiz` tiñe el ambiente según el juego activo (rosco ámbar, trivia celeste,
// basta fucsia, supervivencia rojo): cada partida "se siente distinta".
// También actualiza el theme-color del navegador para casar la barra del celu.

import React, { useEffect, useRef } from 'react';
import { GAMA_BAJA } from '../utils/rendimiento';

export default function FondoAnimado({ densidad = 70, titilar = true, matiz = 270 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', `hsl(${matiz} 45% 7%)`);
  }, [matiz]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let animacionId = 0;
    let particulas = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Con reduce-motion se dibuja UN frame fijo (sin loop); en gama baja se
    // recorta la densidad para no gastar GPU en celulares modestos.
    const reducir = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    const densidadEfectiva = reducir
      ? Math.min(densidad, 16)
      : GAMA_BAJA
        ? Math.min(densidad, 28)
        : densidad;

    function dimensionar() {
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
    }

    function crearParticulas() {
      // Tono de las estrellas sesgado hacia el matiz del juego activo.
      const tonos = [matiz, (matiz + 55) % 360, (matiz + 325) % 360];
      particulas = Array.from({ length: densidadEfectiva }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: (Math.random() * 1.6 + 0.4) * dpr,
        vx: (Math.random() - 0.5) * 0.14 * dpr,
        vy: (Math.random() - 0.5) * 0.14 * dpr,
        alphaBase: Math.random() * 0.35 + 0.18,
        // Titilar: cada estrella respira con su propio ritmo y fase.
        fase: Math.random() * Math.PI * 2,
        velocidadTitilo: Math.random() * 1.6 + 0.5,
        amplitudTitilo: Math.random() * 0.22 + 0.08,
        tono: tonos[Math.floor(Math.random() * tonos.length)],
      }));
    }

    let t0 = performance.now();
    function dibujar(t) {
      const tiempo = (t - t0) / 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of particulas) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        // Respiro delicada: oscila alrededor de su brillo base.
        const alpha = titilar
          ? p.alphaBase + Math.sin(tiempo * p.velocidadTitilo + p.fase) * p.amplitudTitilo
          : p.alphaBase;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.tono}, 95%, 68%, ${Math.max(0.05, alpha)})`;
        ctx.fill();

        // Halo suave solo en las estrellas más grandes (efecto "luz viva").
        if (p.r > 1.6 * dpr && alpha > p.alphaBase + 0.1) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${p.tono}, 95%, 70%, ${alpha * 0.12})`;
          ctx.fill();
        }
      }

      if (!reducir) animacionId = requestAnimationFrame(dibujar);
    }

    function alVisibilidad() {
      if (document.hidden) cancelAnimationFrame(animacionId);
      else if (!reducir) animacionId = requestAnimationFrame(dibujar);
    }

    dimensionar();
    crearParticulas();
    animacionId = requestAnimationFrame(dibujar);

    const alRedimensionar = () => {
      dimensionar();
      crearParticulas();
    };
    window.addEventListener('resize', alRedimensionar);
    document.addEventListener('visibilitychange', alVisibilidad);

    return () => {
      cancelAnimationFrame(animacionId);
      window.removeEventListener('resize', alRedimensionar);
      document.removeEventListener('visibilitychange', alVisibilidad);
    };
  }, [densidad, titilar, matiz]);

  const orbe = (tono) => ({
    background: `radial-gradient(circle, hsla(${tono}, 85%, 62%, 0.26) 0%, transparent 70%)`,
  });

  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-[#0B0616]">
      {/* Orbes de gradiente (tiñen el matiz del juego activo) */}
      <div
        style={orbe(matiz)}
        className="absolute -top-32 -left-32 h-[28rem] w-[28rem] rounded-full blur-3xl animate-blob"
      />
      <div
        style={orbe((matiz + 40) % 360)}
        className="absolute top-1/3 -right-40 h-[32rem] w-[32rem] rounded-full blur-3xl animate-blob animacion-lenta"
      />
      <div
        style={orbe((matiz + 320) % 360)}
        className="absolute -bottom-40 left-1/4 h-[26rem] w-[26rem] rounded-full blur-3xl animate-blob animacion-retraso"
      />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* Vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(5,2,12,0.9)_100%)]" />
    </div>
  );
}
