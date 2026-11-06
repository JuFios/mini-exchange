import type { BookOrder } from './book';

export type StpPolicy = (incoming: BookOrder, resting: BookOrder) => boolean;

export const cancelNewest: StpPolicy = (incoming, resting) =>
  incoming.ownerId === resting.ownerId;
