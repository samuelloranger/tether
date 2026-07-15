import React from 'react';
import { View } from 'react-native';
import type { Presentation } from './presentations';

export function PresentationView({ preview, url }: { preview: Presentation; url: string }) {
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
