/// <reference types="expo/types" />

// @tabler/icons-react-native 3.x points its per-icon `exports` types at a path it does not ship
// (dist/icons/*.d.ts; the files are in dist/icons/icons/). The components are all the same type.
declare module '@tabler/icons-react-native/*' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react'
  import type { SvgProps } from 'react-native-svg'
  const Icon: ForwardRefExoticComponent<SvgProps & { size?: number | string; color?: string; strokeWidth?: number | string; title?: string } & RefAttributes<unknown>>
  export default Icon
}
