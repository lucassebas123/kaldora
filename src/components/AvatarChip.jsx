// src/components/AvatarChip.jsx
// Insignia de jugador: ícono + color. Recibe el nombre del ícono guardado en
// la base y lo resuelve en el catálogo de lucide.

import React from 'react';
import { Star } from 'lucide-react';
import { ICONOS_DISPONIBLES } from '../constants/avatares';

export default function AvatarChip({ icono, color, tamano = 'md', online = null }) {
  const Icono = ICONOS_DISPONIBLES[icono] || Star;
  const medidas = { sm: 'h-8 w-8', md: 'h-10 w-10', lg: 'h-14 w-14', xl: 'h-20 w-20' }[tamano];
  const iconoSize = { sm: 15, md: 18, lg: 26, xl: 36 }[tamano];

  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={`flex ${medidas} items-center justify-center rounded-full ${color} shadow-lg shadow-black/30`}
      >
        <Icono size={iconoSize} color="white" strokeWidth={2.5} />
      </span>
      {online !== null && (
        <span
          title={online ? 'Conectado' : 'Desconectado'}
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#0B0616] ${
            online ? 'bg-green-400' : 'bg-red-500/70'
          }`}
        />
      )}
    </span>
  );
}
