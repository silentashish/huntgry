import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold'
import { BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque/700Bold'
import { BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque/800ExtraBold'
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular'
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium'
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold'
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono/500Medium'
import { useFonts } from 'expo-font'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { PushProvider } from '../notifications/PushProvider'
import { RemoteProvider, useRemote } from '../state/RemoteProvider'
import { dark, light, useScheme } from '../ui/theme'

void SplashScreen.preventAutoHideAsync()

function Routes() {
  const snap = useRemote()
  const scheme = useScheme()
  const colors = scheme === 'dark' ? dark : light
  const ready = snap.phase !== 'loading'
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return null
  const paired = snap.phase === 'paired'
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme
  return (
    <ThemeProvider value={{ ...base, colors: { ...base.colors, background: colors.bgCanvas, card: colors.bgSurface, text: colors.textPrimary, border: colors.borderSubtle, primary: colors.accentPrimary } }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: colors.bgCanvas } }}>
        {/* Paired: the tabs. Not paired (first launch, unpaired, "Pair again"): only Pair. */}
        <Stack.Protected guard={paired}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={!paired}>
          <Stack.Screen name="pair" />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  )
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    BricolageGrotesque_800ExtraBold,
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    GeistMono_500Medium
  })
  if (!fontsLoaded && !fontError) return null
  return (
    <SafeAreaProvider>
      <RemoteProvider>
        <PushProvider>
          <Routes />
        </PushProvider>
      </RemoteProvider>
    </SafeAreaProvider>
  )
}
