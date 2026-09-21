import 'dotenv/config';
import { getProfile } from '../../shared/profile.js';
export const profile = getProfile(process.env.APP_PROFILE || 'ink');
export const isPet = profile.id === 'pet';

export const PET_SHOP_ID = -1;
export const businessUserId = (id) => isPet ? PET_SHOP_ID : id;
