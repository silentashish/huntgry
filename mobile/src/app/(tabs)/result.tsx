import { useLocalSearchParams } from 'expo-router'
import { ReviewScreen } from '../../screens/ReviewScreen'

/** `/result?app=<application id>`: application ids are folder paths, so they travel as a query parameter. */
export default function Result() {
  const { app } = useLocalSearchParams<{ app: string }>()
  return app ? <ReviewScreen key={app} applicationId={app} /> : null
}
