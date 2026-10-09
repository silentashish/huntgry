// Metro for the npm workspace (Expo SDK 57 monorepo guide): `getDefaultConfig` already watches
// the workspace packages and the root node_modules and resolves from mobile/node_modules first.
// One thing it cannot know: the root depends on React 19.3 for the desktop renderer, while
// React Native 0.86 needs exactly the React it was built with (19.2.x, in mobile/node_modules).
// Hoisted packages (react-native, expo-router, …) would otherwise resolve the root's copy and
// load two Reacts, so every `react` / `react-dom` import resolves as if it came from this app.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const config = getDefaultConfig(projectRoot)

const PINNED = ['react', 'react-dom']
const appOrigin = path.join(projectRoot, 'package.json')

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (PINNED.some((name) => moduleName === name || moduleName.startsWith(`${name}/`))) {
    return context.resolveRequest({ ...context, originModulePath: appOrigin }, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
