import React from 'react';
import { Platform, View } from 'react-native';
import type { Presentation } from './presentations';

declare const require: (id: string) => { default: React.ComponentType<Record<string, unknown>> };

export function PresentationView({ preview, url }: { preview: Presentation; url: string }) {
  if (Platform.OS === 'web') {
    return (
      <View style={{ flex: 1 }}>
        {React.createElement('iframe', {
          key: `${preview.id}:${preview.revision}`,
          src: url,
          title: preview.title,
          style: { border: 0, width: '100%', height: '100%', display: 'block' },
        })}
      </View>
    );
  }
  const WebView = require('react-native-webview').default;
  return (
    <WebView
      key={`${preview.id}:${preview.revision}`}
      source={{ uri: url }}
      originWhitelist={['*']}
      style={{ flex: 1 }}
      allowsBackForwardNavigationGestures={false}
    />
  );
}
