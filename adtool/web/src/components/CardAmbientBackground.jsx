import { useEffect, useRef } from 'react';
import { subscribeCardShader } from './cardShaderRenderer.js';
import './CardAmbientBackground.css';

const EFFECTS = {
  aba: 'waves', builder: 'aurora', manual: 'gradient', optimizer: 'waves',
  library: 'aurora', skus: 'gradient', portfolios: 'aurora', products: 'gradient',
  tools: 'gradient', agedFees: 'waves', admin: 'aurora',
};

export default function CardAmbientBackground({ id, slice }) {
  const effect = EFFECTS[id] || 'gradient';
  const canvasRef = useRef(null);
  const { axis, offset, size, cardWidth, cardHeight, back } = slice;
  useEffect(() => {
    if (back || !canvasRef.current) return undefined;
    return subscribeCardShader(canvasRef.current, effect, { axis, offset, size, cardWidth, cardHeight });
  }, [effect, axis, offset, size, cardWidth, cardHeight, back]);
  const position = axis === 'x' ? { top: offset, left: 0, width: cardWidth, height: size }
    : { left: offset, top: 0, width: size, height: cardHeight };
  return (
    <div className={`card-ambient card-ambient--${effect}`} data-effect={effect} aria-hidden="true">
      <div className="card-ambient-fallback" />
      {!back && <canvas ref={canvasRef} className="card-ambient-canvas" style={position} />}
    </div>
  );
}
