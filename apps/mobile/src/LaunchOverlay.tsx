import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, useColorScheme, View } from 'react-native';

// These MUST mirror the expo-splash-screen plugin config in app.json. The overlay
// is a pixel-identical continuation of the native splash, so the native → JS
// handoff is invisible; only then do we animate away to reveal the app.
const LOCKUP_WIDTH = 240;
const LOCKUP_ASPECT = 1100 / 700;
const DARK_BACKGROUND = '#05070e';
const LIGHT_BACKGROUND = '#eff1f5';

const LOCKUPS = {
  dark: require('../assets/splash-dark.png'),
  light: require('../assets/splash-light.png'),
};

export function LaunchOverlay({ ready }: { ready: boolean }) {
  const scheme = useColorScheme();
  const isDark = scheme !== 'light';
  const [done, setDone] = useState(false);
  const [progress] = useState(() => new Animated.Value(0));
  const hidden = useRef(false);

  // Hide the native splash only once our identical overlay has been laid out,
  // otherwise the window flashes empty between the two.
  const handleLayout = () => {
    if (hidden.current) return;
    hidden.current = true;
    SplashScreen.hideAsync().catch(() => {});
  };

  useEffect(() => {
    if (!ready) return;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 420,
      delay: 120,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => finished && setDone(true));
    return () => animation.stop();
  }, [ready, progress]);

  if (done) return null;

  const lockupStyle = {
    width: LOCKUP_WIDTH,
    height: LOCKUP_WIDTH / LOCKUP_ASPECT,
    opacity: progress.interpolate({
      inputRange: [0, 0.55],
      outputRange: [1, 0],
      extrapolate: 'clamp' as const,
    }),
    transform: [
      {
        scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }),
      },
    ],
  };

  return (
    <Animated.View
      testID="launch-overlay"
      pointerEvents={done ? 'none' : 'auto'}
      onLayout={handleLayout}
      style={[
        StyleSheet.absoluteFill,
        styles.overlay,
        {
          backgroundColor: isDark ? DARK_BACKGROUND : LIGHT_BACKGROUND,
          opacity: progress.interpolate({
            inputRange: [0, 0.45, 1],
            outputRange: [1, 1, 0],
          }),
        },
      ]}
    >
      <View style={styles.center}>
        <Animated.Image
          source={isDark ? LOCKUPS.dark : LOCKUPS.light}
          resizeMode="contain"
          style={lockupStyle}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { zIndex: 1000, elevation: 1000 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
