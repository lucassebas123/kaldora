// src/components/Skeleton.jsx
//
// Placeholder con shimmer para cargas de pregunta/ranking. Respeta
// prefers-reduced-motion (la clase .skeleton deja de animar en index.css).

import React from 'react';

export function SkeletonLineas({ lineas = 2, className = '' }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lineas }, (_, i) => (
        <div
          key={i}
          className="skeleton h-4"
          style={{ width: i === lineas - 1 ? '62%' : '100%' }}
        />
      ))}
    </div>
  );
}

export default SkeletonLineas;
