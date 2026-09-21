import { getProfile } from '../../shared/profile.js';
export let profile = getProfile();
export let isPet = false;
export function configureProfile(id) {
  profile = getProfile(id);
  isPet = profile.id === 'pet';
}
export const emptyLibrary = () => ({ libs: [], items: {}, config: [], scopes: {} });
