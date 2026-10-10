import { Tabs } from 'expo-router/js-tabs'
import { useCallback } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useModel, useRemote } from '../../state/RemoteProvider'
import { TabBar } from '../../ui/TabBar'
import { Toast } from '../../ui/Toast'
import { useColors } from '../../ui/theme'

export default function TabsLayout() {
  const colors = useColors()
  const snap = useRemote()
  const model = useModel()
  const insets = useSafeAreaInsets()
  const dismiss = useCallback(() => model.dismissToast(), [model])
  return (
    <View style={{ flex: 1, backgroundColor: colors.bgCanvas }}>
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bgCanvas }, animation: 'fade' }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="queue" options={{ title: 'Queue' }} />
        <Tabs.Screen name="review" options={{ title: 'Review' }} />
        <Tabs.Screen name="jobs" options={{ title: 'Jobs' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
        <Tabs.Screen name="run/[id]" options={{ href: null, title: 'Run' }} />
        <Tabs.Screen name="pipeline" options={{ href: null, title: 'Pipeline' }} />
        <Tabs.Screen name="result" options={{ href: null, title: 'Result' }} />
        <Tabs.Screen name="files" options={{ href: null, title: 'Files' }} />
      </Tabs>
      <Toast toast={snap.toast} onDismiss={dismiss} bottom={Math.max(insets.bottom, 28) + 72} />
    </View>
  )
}
