import WebView from 'react-native-webview';
import type { Presentation } from './presentations';

export function PresentationView({ preview, url }: { preview: Presentation; url: string }) {
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
