import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, PanResponder, Platform, StyleSheet, View } from 'react-native';
import { BACK_EDGE_WIDTH, shouldFinishEdgeBack, shouldStartEdgeBack } from './edgeBack';

/** Interactive pop for the app's existing local routes. Modal sheets live outside it. */
export function EdgeBackScreen({ children, enabled, navigationKey, onBack, backgroundColor, renderPrevious }: {
  children: React.ReactNode;
  enabled: boolean;
  navigationKey: string;
  onBack: () => void;
  backgroundColor: string;
  renderPrevious: () => React.ReactNode;
}) {
  const [showPrevious, setShowPrevious] = useState(false);
  const translation = useRef(new Animated.Value(0)).current;
  const host = useRef<React.ComponentRef<typeof View>>(null);
  const geometry = useRef({ x: 0, width: 1 });
  const touch = useRef({ x: 0, eligible: false, active: false, settling: false });
  const current = useRef({ enabled, navigationKey, onBack });
  current.current = { enabled, navigationKey, onBack };
  const reduceMotion = useRef(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) reduceMotion.current = value; });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { reduceMotion.current = value; });
    return () => { mounted = false; subscription.remove(); };
  }, []);
  useLayoutEffect(() => {
    touch.current.active = false;
    touch.current.eligible = false;
    touch.current.settling = false;
    setShowPrevious(false);
    translation.stopAnimation();
    translation.setValue(0);
    return () => { translation.stopAnimation(); };
  }, [navigationKey, enabled, translation]);

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponderCapture: event => {
      if (touch.current.active) return false;
      const x = event.nativeEvent.pageX;
      touch.current.x = x;
      touch.current.eligible = current.current.enabled && !touch.current.settling && event.nativeEvent.touches.length === 1
        && x - geometry.current.x >= 0 && x - geometry.current.x <= BACK_EDGE_WIDTH;
      return false;
    },
    onMoveShouldSetPanResponderCapture: (_event, gesture) => {
      if (gesture.numberActiveTouches !== 1) touch.current.eligible = false;
      if (Math.abs(gesture.dy) > 6 && Math.abs(gesture.dy) >= Math.abs(gesture.dx)) touch.current.eligible = false;
      return touch.current.eligible && shouldStartEdgeBack(touch.current.x - geometry.current.x,
        gesture.moveX - touch.current.x, gesture.dy, gesture.numberActiveTouches);
    },
    onPanResponderGrant: event => {
      touch.current.active = true;
      setShowPrevious(true);
      translation.stopAnimation();
      // The move that wins the responder is a grant, not an onMove callback.
      translation.setValue(Math.min(geometry.current.width, Math.max(0, event.nativeEvent.pageX - touch.current.x)));
    },
    onPanResponderStart: (_event, gesture) => {
      if (gesture.numberActiveTouches !== 1) { touch.current.eligible = false; translation.setValue(0); }
    },
    onPanResponderMove: (_event, gesture) => {
      if (gesture.numberActiveTouches !== 1) { touch.current.eligible = false; translation.setValue(0); return; }
      if (touch.current.eligible) translation.setValue(Math.min(geometry.current.width, Math.max(0, gesture.moveX - touch.current.x)));
    },
    onPanResponderRelease: (_event, gesture) => {
      const pop = touch.current.eligible && shouldFinishEdgeBack(gesture.moveX - touch.current.x, gesture.vx, geometry.current.width);
      touch.current.active = false;
      touch.current.eligible = false;
      touch.current.settling = true;
      const route = current.current.navigationKey;
      Animated.timing(translation, { toValue: pop ? geometry.current.width : 0,
        duration: reduceMotion.current ? 0 : pop ? 180 : 220, easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web' }).start(({ finished }) => {
        touch.current.settling = false;
        setShowPrevious(false);
        if (finished && pop && current.current.enabled && current.current.navigationKey === route) current.current.onBack();
      });
    },
    onPanResponderTerminationRequest: () => true,
    onPanResponderTerminate: () => {
      touch.current.active = false;
      touch.current.eligible = false;
      touch.current.settling = true;
      Animated.timing(translation, { toValue: 0, duration: reduceMotion.current ? 0 : 180, useNativeDriver: Platform.OS !== 'web' }).start(() => {
        touch.current.settling = false;
        setShowPrevious(false);
      });
    },
  })).current;

  return <View ref={host} testID="edge-back-screen" style={[styles.fill, { backgroundColor }]}
    onLayout={event => {
      geometry.current.width = event.nativeEvent.layout.width;
      host.current?.measureInWindow(x => { geometry.current.x = x; });
    }} {...responder.panHandlers}>
    {showPrevious && <Animated.View testID="edge-back-preview" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { backgroundColor, transform: [{ translateX: Animated.multiply(Animated.subtract(translation, geometry.current.width), 0.25) }] }]}>
      {renderPrevious()}
    </Animated.View>}
    <Animated.View testID="edge-back-surface" style={[styles.fill, { backgroundColor, transform: [{ translateX: translation }] }]}>
      {children}
      {/* WebView owns native touches; this narrow strip keeps the edge available. */}
      {enabled && <View testID="edge-back-strip" accessible={false} style={styles.edge} />}
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
  edge: { position: 'absolute', left: 0, top: 0, bottom: 0, width: BACK_EDGE_WIDTH },
});
