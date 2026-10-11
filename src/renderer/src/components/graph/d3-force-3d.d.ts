// Minimal types for the forces used here; d3-force-3d ships no declarations.
declare module 'd3-force-3d' {
  interface PositionForce {
    strength(s: number): PositionForce
  }
  interface CollideForce {
    strength(s: number): CollideForce
  }
  export function forceX(x?: number): PositionForce
  export function forceY(y?: number): PositionForce
  export function forceCollide(radius?: number | ((node: unknown) => number)): CollideForce
}
