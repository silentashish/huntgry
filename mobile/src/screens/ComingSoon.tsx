import { View } from 'react-native'
import { useRemote } from '../state/RemoteProvider'
import { Card } from '../ui/Card'
import { FadeIn } from '../ui/FadeIn'
import { Icon, type IconName } from '../ui/Icon'
import { Screen, ScreenHeader } from '../ui/Screen'
import { radius, useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

/** Review (#42) and Jobs (#40) tabs until their gateway work lands. */
export function ComingSoon({ title, eyebrow, icon, body }: { title: string; eyebrow: string; icon: IconName; body: string }) {
  const colors = useColors()
  const snap = useRemote()
  const unreviewed = snap.status?.review.unreviewed ?? 0
  return (
    <Screen>
      <ScreenHeader eyebrow={eyebrow} title={title} />
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <FadeIn>
          <Card padding={20} gap={12} style={{ alignItems: 'center' }}>
            <View style={{ width: 56, height: 56, borderRadius: radius.full, backgroundColor: colors.accentPrimarySoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={icon} size={26} color={colors.textAccent} />
            </View>
            <Txt variant="headingMd" align="center">
              Coming with the next update
            </Txt>
            <Txt variant="bodySm" color="textSecondary" align="center">
              {body}
            </Txt>
            {title === 'Review' && unreviewed > 0 ? (
              <Txt variant="monoSm" color="textAccent">
                {unreviewed} waiting on your Mac
              </Txt>
            ) : null}
          </Card>
        </FadeIn>
      </View>
    </Screen>
  )
}
