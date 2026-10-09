import { useLocalSearchParams } from 'expo-router'
import { RunScreen } from '../../../screens/RunScreen'

export default function Run() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <RunScreen key={id} runId={id} />
}
