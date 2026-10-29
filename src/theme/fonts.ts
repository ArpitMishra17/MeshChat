/**
 * Chakra Petch (display) + Share Tech Mono (body). React Native cannot
 * synthesize weights for custom fonts, so each weight is its own family —
 * never combine these with `fontWeight`.
 *
 * Assets are required directly (not via the package index) so Metro only
 * bundles the three weights we actually use.
 */
export const fonts = {
  mono: 'ShareTechMono_400Regular',
  disp: 'ChakraPetch_600SemiBold',
  dispMed: 'ChakraPetch_500Medium',
  dispBold: 'ChakraPetch_700Bold',
} as const;

export const fontAssets = {
  ShareTechMono_400Regular: require('@expo-google-fonts/share-tech-mono/400Regular/ShareTechMono_400Regular.ttf'),
  ChakraPetch_500Medium: require('@expo-google-fonts/chakra-petch/500Medium/ChakraPetch_500Medium.ttf'),
  ChakraPetch_600SemiBold: require('@expo-google-fonts/chakra-petch/600SemiBold/ChakraPetch_600SemiBold.ttf'),
  ChakraPetch_700Bold: require('@expo-google-fonts/chakra-petch/700Bold/ChakraPetch_700Bold.ttf'),
};

export const fontSize = {
  micro: 9,
  xs: 10,
  sm: 12,
  md: 13,
  lg: 15,
  xl: 20,
  xxl: 38,
} as const;
