// Hermes has no crypto.getRandomValues: this polyfill must load before tweetnacl (through
// @huntgry/remote-protocol) asks for random bytes, so it is the very first import.
import 'react-native-get-random-values'
import 'expo-router/entry'
