import { Redirect } from 'expo-router';

/** Manager app opens on Schedule; no separate home tab. */
export default function ManagerIndex() {
  return <Redirect href="/manager/schedule" />;
}
