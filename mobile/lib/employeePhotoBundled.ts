import type { ImageSourcePropType } from 'react-native';

/**
 * Bundled roster photos in `mobile/assets/employee-photos/`.
 * Prefer .jpg when both formats exist — matches web candidate order.
 */
export const BUNDLED_EMPLOYEE_PHOTOS: Record<string, ImageSourcePropType> = {
  abel_lujan: require('../assets/employee-photos/abel_lujan.jpg'),
  angelyn_gella: require('../assets/employee-photos/angelyn_gella.jpg'),
  armando_cumes: require('../assets/employee-photos/armando_cumes.jpg'),
  baltazar_lucas: require('../assets/employee-photos/baltazar_lucas.jpg'),
  bernabe_de_leon: require('../assets/employee-photos/bernabe_de_leon.jpg'),
  charles_jakob_zacani: require('../assets/employee-photos/charles_jakob_zacani.jpg'),
  enrique_cumes: require('../assets/employee-photos/enrique_cumes.jpg'),
  eugene_villarruz: require('../assets/employee-photos/eugene_villarruz.jpg'),
  jon_arellano: require('../assets/employee-photos/jon_arellano.jpg'),
  juan_salvatierra: require('../assets/employee-photos/juan_salvatierra.jpg'),
  mark_ong: require('../assets/employee-photos/mark_ong.jpg'),
  natalio_de_la_cruz: require('../assets/employee-photos/natalio_de_la_cruz.jpg'),
  zeferino_flores: require('../assets/employee-photos/zeferino_flores.jpg'),
};
