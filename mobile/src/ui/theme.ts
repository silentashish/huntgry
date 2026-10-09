/**
 * Scent Trail tokens (Figma "Foundations": Primitives, Color Light / Dark, Spacing, Radius,
 * text and effect styles), the same values as the website's tokens.css. Light is the base;
 * dark follows the system appearance.
 */

import { useColorScheme } from 'react-native'

export const palette = {
  ink950: '#07090d',
  ink900: '#0b0f15',
  ink850: '#10161f',
  ink800: '#151d28',
  ink700: '#1e2836',
  ink600: '#2a3645',
  ink500: '#3d4a5c',
  ink400: '#5b6b80',
  ink300: '#8494a8',
  ink200: '#b3bfce',
  ink100: '#d9e0e8',
  ink50: '#eef2f6',
  bone50: '#fbfaf7',
  bone100: '#f4f2ec',
  bone200: '#e9e5dc',
  bone300: '#dad4c6',
  ember100: '#ffefdf',
  ember200: '#ffd9ae',
  ember300: '#ffc46b',
  ember400: '#ffa53d',
  ember500: '#ff8a1f',
  ember600: '#e66e0a',
  ember700: '#b85405',
  ember900: '#2a1b0e',
  trail100: '#dff7f1',
  trail400: '#3be3c2',
  trail600: '#0e9e85',
  trail900: '#0e2a26',
  green100: '#dcf7e6',
  green500: '#3ecf72',
  green600: '#1fa85a',
  green900: '#0e2a1a',
  red100: '#fde2e3',
  red500: '#f2555a',
  red600: '#d23a40',
  red900: '#2e1214',
  amber100: '#fff4cc',
  amber500: '#f5b700',
  amber600: '#c99400',
  amber900: '#2a2208',
  blue100: '#e0ebff',
  blue500: '#4f8dff',
  blue600: '#3470e0',
  blue900: '#0f1b33',
  violet100: '#ece6ff',
  violet500: '#9b7bff',
  violet600: '#7a5be0',
  violet900: '#1c1533'
} as const

export interface Colors {
  bgCanvas: string
  bgSurface: string
  bgSurfaceRaised: string
  bgSurfaceSunken: string
  bgSubtle: string
  bgHover: string
  bgActive: string
  bgOverlay: string
  borderSubtle: string
  borderDefault: string
  borderStrong: string
  borderFocus: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  textOnAccent: string
  textAccent: string
  textLink: string
  iconDefault: string
  iconMuted: string
  accentPrimary: string
  accentPrimaryHover: string
  accentPrimarySoft: string
  accentSecondary: string
  accentSecondarySoft: string
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  info: string
  infoSoft: string
  review: string
  reviewSoft: string
}

export const light: Colors = {
  bgCanvas: palette.bone50,
  bgSurface: '#ffffff',
  bgSurfaceRaised: '#ffffff',
  bgSurfaceSunken: palette.bone100,
  bgSubtle: palette.bone200,
  bgHover: '#0b0f150f',
  bgActive: '#0b0f151f',
  bgOverlay: '#0b0f1599',
  borderSubtle: palette.bone200,
  borderDefault: palette.ink100,
  borderStrong: palette.ink200,
  borderFocus: palette.ember600,
  textPrimary: palette.ink900,
  textSecondary: palette.ink500,
  textMuted: palette.ink400,
  textOnAccent: palette.ink950,
  textAccent: palette.ember600,
  textLink: palette.trail600,
  iconDefault: palette.ink500,
  iconMuted: palette.ink300,
  accentPrimary: palette.ember600,
  accentPrimaryHover: palette.ember700,
  accentPrimarySoft: palette.ember100,
  accentSecondary: palette.trail600,
  accentSecondarySoft: palette.trail100,
  success: palette.green600,
  successSoft: palette.green100,
  warning: palette.amber600,
  warningSoft: palette.amber100,
  danger: palette.red600,
  dangerSoft: palette.red100,
  info: palette.blue600,
  infoSoft: palette.blue100,
  review: palette.violet600,
  reviewSoft: palette.violet100
}

export const dark: Colors = {
  bgCanvas: palette.ink950,
  bgSurface: palette.ink900,
  bgSurfaceRaised: palette.ink850,
  bgSurfaceSunken: palette.ink950,
  bgSubtle: palette.ink800,
  bgHover: '#ffffff0f',
  bgActive: '#ffffff1f',
  bgOverlay: '#000000b2',
  borderSubtle: palette.ink800,
  borderDefault: palette.ink700,
  borderStrong: palette.ink600,
  borderFocus: palette.ember500,
  textPrimary: palette.ink50,
  textSecondary: palette.ink300,
  textMuted: palette.ink400,
  textOnAccent: palette.ink950,
  textAccent: palette.ember400,
  textLink: palette.trail400,
  iconDefault: palette.ink300,
  iconMuted: palette.ink500,
  accentPrimary: palette.ember500,
  accentPrimaryHover: palette.ember400,
  accentPrimarySoft: palette.ember900,
  accentSecondary: palette.trail400,
  accentSecondarySoft: palette.trail900,
  success: palette.green500,
  successSoft: palette.green900,
  warning: palette.amber500,
  warningSoft: palette.amber900,
  danger: palette.red500,
  dangerSoft: palette.red900,
  info: palette.blue500,
  infoSoft: palette.blue900,
  review: palette.violet500,
  reviewSoft: palette.violet900
}

export const space = { 0: 0, 1: 2, 2: 4, 3: 8, 4: 12, 5: 16, 6: 20, 7: 24, 8: 32, 9: 40, 10: 48, 11: 64 } as const

export const radius = { xs: 4, sm: 6, md: 10, lg: 14, xl: 20, '2xl': 28, full: 999 } as const

/** Font family names as registered with expo-font (one family per weight, as React Native needs). */
export const fonts = {
  displayBold: 'BricolageGrotesque_700Bold',
  displaySemiBold: 'BricolageGrotesque_600SemiBold',
  ui: 'Geist_400Regular',
  uiMedium: 'Geist_500Medium',
  uiSemiBold: 'Geist_600SemiBold',
  monoMedium: 'GeistMono_500Medium'
} as const

/**
 * Text styles from the Figma file. Figma letter spacing is in % of the size (mono/sm 6 % of 11 px
 * = 0.66 px); React Native wants points.
 */
export const type = {
  displayLg: { fontFamily: fonts.displayBold, fontSize: 40, lineHeight: 46, letterSpacing: -0.8 },
  displayMd: { fontFamily: fonts.displayBold, fontSize: 32, lineHeight: 38, letterSpacing: -0.48 },
  headingXl: { fontFamily: fonts.displaySemiBold, fontSize: 24, lineHeight: 30, letterSpacing: -0.24 },
  headingMd: { fontFamily: fonts.uiSemiBold, fontSize: 16, lineHeight: 22, letterSpacing: -0.032 },
  headingSm: { fontFamily: fonts.uiSemiBold, fontSize: 14, lineHeight: 20 },
  bodyMd: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22 },
  bodySm: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18 },
  bodyXs: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 16 },
  labelMd: { fontFamily: fonts.uiMedium, fontSize: 13, lineHeight: 16 },
  labelSm: { fontFamily: fonts.uiMedium, fontSize: 11, lineHeight: 14 },
  monoSm: { fontFamily: fonts.monoMedium, fontSize: 11, lineHeight: 14, letterSpacing: 0.66 },
  monoXs: { fontFamily: fonts.monoMedium, fontSize: 10, lineHeight: 12, letterSpacing: 0.8 }
} as const

export type TypeName = keyof typeof type

export type Scheme = 'light' | 'dark'

export function useScheme(): Scheme {
  return useColorScheme() === 'dark' ? 'dark' : 'light'
}

export function useColors(): Colors {
  return useScheme() === 'dark' ? dark : light
}

/** glow/ember: the primary call to action. */
export function emberGlow(colors: Colors) {
  return {
    shadowColor: colors.accentPrimary,
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8
  }
}
