import { useLocalSearchParams } from 'expo-router'
import { FilesScreen } from '../../screens/FilesScreen'

export default function Files() {
  const { app } = useLocalSearchParams<{ app: string }>()
  return app ? <FilesScreen key={app} applicationId={app} /> : null
}
