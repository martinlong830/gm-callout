import { useEffect, useMemo, useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type ViewStyle,
} from 'react-native';
import type { EmployeeRow } from '../lib/employees';
import {
  employeePhotoInitials,
  employeePhotoSources,
  type EmployeePhotoSource,
} from '../lib/employeePhotos';

type Props = {
  employee: EmployeeRow;
  size?: number;
  style?: ViewStyle;
  /** Bump after upload/remove so the image reloads. */
  version?: number;
};

function sourceKey(src: EmployeePhotoSource | undefined): string {
  if (!src) return '';
  if (src.kind === 'bundled') return `bundled-${String(src.source)}`;
  return src.uri;
}

export function EmployeePhoto({ employee, size = 52, style, version = 0 }: Props) {
  const sources = useMemo(
    () => employeePhotoSources(employee),
    [employee, employee.meta?.photoUrl, employee.meta?.photoUseCustom, employee.meta?.photoHidden, version]
  );
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const current = sources[idx];
  const initials = employeePhotoInitials(employee);
  const radius = size / 2;

  useEffect(() => {
    setIdx(0);
    setLoaded(false);
  }, [employee.id, version, sources.length, sourceKey(sources[0])]);

  const imageSource: ImageSourcePropType | null = current
    ? current.kind === 'bundled'
      ? current.source
      : { uri: current.uri }
    : null;

  return (
    <View
      style={[
        styles.wrap,
        { width: size, height: size, borderRadius: radius },
        style,
      ]}
    >
      {!loaded ? (
        <Text style={[styles.initials, { fontSize: size * 0.28 }]}>{initials}</Text>
      ) : null}
      {imageSource ? (
        <Image
          key={`${employee.id}-${idx}-${version}`}
          source={imageSource}
          style={[styles.img, { width: size, height: size, borderRadius: radius }]}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            if (idx + 1 < sources.length) setIdx((i) => i + 1);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#e5e7eb',
    borderWidth: 1,
    borderColor: '#e8eaed',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontWeight: '600',
    color: '#6b7280',
    letterSpacing: 0.5,
  },
  img: {
    position: 'absolute',
    top: 0,
    left: 0,
    backgroundColor: '#e5e7eb',
  },
});
