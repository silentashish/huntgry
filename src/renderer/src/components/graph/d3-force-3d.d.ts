// Minimal types for the two forces used here; d3-force-3d ships no declarations.
declare module 'd3-force-3d' {
  interface PositionForce {
    strength(s: number): PositionForce
  }
  export function forceX(x?: number): PositionForce
  export function forceY(y?: number): PositionForce
}
